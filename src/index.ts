interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Country reference data — keyless, from the dataset REST Countries is built on.
 *
 * WHY THIS EXISTS: restcountries.com deprecated v3.1 and every path on that
 * host now 301s to a static `legacy.json` that returns **HTTP 200** with
 * `{success:false, data:null, errors:[…]}`. Callers that check `res.ok` sail
 * straight past it, then find the body isn't the array they expected and
 * normalize to `[]`. That is exactly what happened here: the `countries` pack
 * returned `{results:[]}` for every query for an unknown number of days without
 * throwing once, and `geo.get_country` blew up on `data[0].name` and had the
 * resulting TypeError misreported to callers as "a required value was missing".
 * v5 exists but requires an API key, which this pack has never needed.
 *
 * So we go to the source: `mledoze/countries` is the open dataset REST
 * Countries itself packages. It's CC-BY-SA, served by jsDelivr, and pinned to a
 * TAG rather than @master — country data changes on the order of once a year,
 * and an unpinned ref means an upstream edit can silently reshape our output.
 *
 * The lesson encoded below: a data source that stops working must FAIL, loudly.
 * Every branch that can't produce real country data throws. Returning an empty
 * array on a broken upstream is what let the original bug hide.
 */

/** Pinned deliberately — see the file header. Bump only with a schema re-check. */
const DATASET_URL = 'https://cdn.jsdelivr.net/gh/mledoze/countries@v4.1.1/countries.json';

/**
 * Population is the one field the dataset doesn't carry, and it's one of the
 * most-asked country facts, so we merge it from the World Bank (keyless).
 * `mrnev=1` = most recent non-empty value per country, so this is one ~50KB
 * call for all ~260 of them rather than a per-country lookup.
 */
const POPULATION_URL =
  'https://api.worldbank.org/v2/country/all/indicator/SP.POP.TOTL?format=json&mrnev=1&per_page=400';

interface CountryRecord {
  name: { common: string; official: string };
  capital?: string[];
  region: string;
  subregion?: string;
  /** null when the World Bank has no series for this territory (see mergePopulation). */
  population: number | null;
  /** Year the population figure is from — omitted when population is null. */
  population_year?: string;
  area?: number;
  languages?: Record<string, string>;
  currencies?: Record<string, { name: string; symbol: string }>;
  flag?: string;
  cca2: string;
  cca3: string;
  flags: { png: string; svg: string };
  latlng?: [number, number];
  borders?: string[];
  tld?: string[];
}

interface RawCountry {
  name?: { common?: string; official?: string };
  capital?: string[];
  region?: string;
  subregion?: string;
  area?: number;
  languages?: Record<string, string>;
  currencies?: Record<string, { name: string; symbol: string }>;
  flag?: string;
  cca2?: string;
  cca3?: string;
  latlng?: [number, number];
  borders?: string[];
  tld?: string[];
}

/**
 * Isolate-lifetime memo. Holds the PROMISE so concurrent requests in the same
 * isolate share one fetch instead of each pulling 1.2MB. Cleared on failure —
 * caching a rejection would turn one bad minute into a dead isolate.
 */
let cache: Promise<CountryRecord[]> | null = null;

function flagUrls(cca2: string): { png: string; svg: string } {
  // flagcdn keys off the lowercase alpha-2 code; this is the same CDN REST
  // Countries served its `flags` field from, so consumers see unchanged URLs.
  const k = cca2.toLowerCase();
  return { png: `https://flagcdn.com/w320/${k}.png`, svg: `https://flagcdn.com/${k}.svg` };
}

/**
 * Best-effort. The World Bank going down must NOT re-break the pack the way
 * restcountries did — a country with a null population is still a useful
 * answer, an exception is not. Callers get `population: null`, which is
 * honest, rather than a stale or invented number.
 */
async function fetchPopulations(): Promise<Map<string, { value: number; year: string }>> {
  const out = new Map<string, { value: number; year: string }>();
  try {
    const res = await fetch(POPULATION_URL);
    if (!res.ok) return out;
    const body = (await res.json()) as unknown;
    // Shape is [meta, rows]; anything else means the API changed under us.
    if (!Array.isArray(body) || body.length < 2 || !Array.isArray(body[1])) return out;
    for (const row of body[1] as { countryiso3code?: string; value?: number; date?: string }[]) {
      const iso3 = row?.countryiso3code;
      if (iso3 && typeof row.value === 'number') {
        out.set(iso3.toUpperCase(), { value: row.value, year: row.date ?? '' });
      }
    }
  } catch {
    // Swallow deliberately — see the doc comment. The caller still gets countries.
  }
  return out;
}

async function loadFresh(): Promise<CountryRecord[]> {
  const res = await fetch(DATASET_URL);
  if (!res.ok) {
    throw new Error(`Country dataset unavailable: HTTP ${res.status} from jsDelivr`);
  }
  const raw = (await res.json()) as unknown;
  // The restcountries failure was a 200 whose BODY was wrong. Check the shape,
  // not just the status, and refuse to serve a plausible-looking empty result.
  if (!Array.isArray(raw) || raw.length < 100) {
    throw new Error(
      `Country dataset malformed: expected an array of ~250 countries, got ${
        Array.isArray(raw) ? `${raw.length} entries` : typeof raw
      }`,
    );
  }

  const populations = await fetchPopulations();

  const records: CountryRecord[] = [];
  for (const c of raw as RawCountry[]) {
    // Every downstream mapper reads name.common and cca2; an entry missing
    // either can't be rendered, so drop it here rather than at five call sites.
    if (!c?.name?.common || !c.cca2 || !c.cca3) continue;
    const pop = populations.get(c.cca3.toUpperCase());
    records.push({
      name: { common: c.name.common, official: c.name.official ?? c.name.common },
      capital: c.capital,
      region: c.region ?? '',
      subregion: c.subregion,
      population: pop?.value ?? null,
      ...(pop?.year ? { population_year: pop.year } : {}),
      area: c.area,
      languages: c.languages,
      currencies: c.currencies,
      flag: c.flag,
      cca2: c.cca2,
      cca3: c.cca3,
      flags: flagUrls(c.cca2),
      latlng: c.latlng,
      borders: c.borders,
      tld: c.tld,
    });
  }

  if (records.length < 100) {
    throw new Error(`Country dataset malformed: only ${records.length} usable entries`);
  }
  return records;
}

/** Load (and memoize) the full country list. Throws if the data is unusable. */
async function loadCountries(): Promise<CountryRecord[]> {
  if (!cache) {
    cache = loadFresh().catch((err) => {
      cache = null; // don't pin a failure for the isolate's lifetime
      throw err;
    });
  }
  return cache;
}

// ── Query helpers ──────────────────────────────────────────────────────
// Substring/case-insensitive matching throughout, because these back
// natural-language tools where the caller types "holland" or "eur", not an
// exact key. Sorting is by population desc where the tool shows a list, with
// nulls last so a missing World Bank series doesn't push a country to the top.

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Population-desc comparator that keeps null populations at the end. */
function byPopulationDesc(a: CountryRecord, b: CountryRecord): number {
  if (a.population === b.population) return a.name.common.localeCompare(b.name.common);
  if (a.population === null) return 1;
  if (b.population === null) return -1;
  return b.population - a.population;
}

async function findCountriesByName(query: string): Promise<CountryRecord[]> {
  const q = norm(query);
  if (!q) return [];
  const all = await loadCountries();
  // Exact common/official match wins outright — "Niger" must not be buried
  // under "Nigeria" just because the substring pass matches both.
  const exact = all.filter((c) => norm(c.name.common) === q || norm(c.name.official) === q);
  if (exact.length) return exact;
  return all
    .filter((c) => norm(c.name.common).includes(q) || norm(c.name.official).includes(q))
    .sort(byPopulationDesc);
}

async function findCountryByCode(code: string): Promise<CountryRecord | null> {
  const c = norm(code);
  if (!c) return null;
  const all = await loadCountries();
  return all.find((x) => norm(x.cca2) === c || norm(x.cca3) === c) ?? null;
}

async function findCountriesByRegion(region: string): Promise<CountryRecord[]> {
  const r = norm(region);
  if (!r) return [];
  const all = await loadCountries();
  return all
    .filter((c) => norm(c.region) === r || norm(c.subregion ?? '') === r)
    .sort(byPopulationDesc);
}

async function findCountriesByLanguage(language: string): Promise<CountryRecord[]> {
  const l = norm(language);
  if (!l) return [];
  const all = await loadCountries();
  // Match the language NAME ("Estonian") or its ISO-639-3 key ("est"), since
  // callers supply either and the dataset stores both.
  return all
    .filter((c) =>
      Object.entries(c.languages ?? {}).some(
        ([key, name]) => norm(key) === l || norm(name).includes(l),
      ),
    )
    .sort(byPopulationDesc);
}

async function findCountriesByCurrency(currency: string): Promise<CountryRecord[]> {
  const cur = norm(currency);
  if (!cur) return [];
  const all = await loadCountries();
  // Match the code ("EUR"), the name ("Euro"), or a partial name ("dollar"),
  // which is how these tools are actually called.
  return all
    .filter((c) =>
      Object.entries(c.currencies ?? {}).some(
        ([code, meta]) => norm(code) === cur || norm(meta?.name ?? '').includes(cur),
      ),
    )
    .sort((a, b) => a.name.common.localeCompare(b.name.common));
}
/**
 * Countries MCP — world country data.
 *
 * Sourced from the open `mledoze/countries` dataset (the same data REST
 * restcountries.com v3.1 was retired and now answers every path with an
 * HTTP 200 deprecation stub, which this pack silently served as `{results:[]}`
 * until 2026-07-26 — see shared/src/countries-data.ts for the full story.
 *
 * Tools:
 * - search_countries: Search countries by name
 * - get_country_by_code: Get country by ISO alpha-2 or alpha-3 code
 * - countries_by_region: List countries in a region
 * - countries_by_language: Find countries by spoken language
 * - countries_by_currency: Find countries using a currency
 */


// ── Name resolution ────────────────────────────────────────────────────

/**
 * `findCountriesByName` matches only `name.common` / `name.official`, first
 * exact then substring. That loses two whole classes of query, both of which
 * return HTTP 200 and therefore log as a success (2026-07-30, verified live
 * against the deployed tool):
 *
 *   "US"   -> Russia, Australia, Austria, Belarus, Cyprus, Mauritius, …
 *   "UK"   -> Ukraine
 *   "USA" / "DEU" / "Holland" / "Burma" / "UAE" / "England" -> 0 results
 *
 * The substring pass is the culprit for the first group — "us" is a substring
 * of RUSsia and BelarUS, and the country the caller meant is not even in the
 * list. The second group is data the shared record simply doesn't carry: the
 * upstream dataset's `altSpellings` and `translations` are dropped by
 * shared/src/countries-data.ts, so ISO codes and everyday alternate names have
 * nothing to match against.
 *
 * Fix, in confidence order: exact name wins, then an exact ISO code, then a
 * curated alias, and only then the loose substring pass. That keeps "New" ->
 * New Zealand / New Caledonia / Papua New Guinea working while "US" now
 * resolves to the United States instead of seven countries it isn't.
 */

/** Everyday / former / native names the dataset's common+official names miss. Values are ISO alpha-3. */
const NAME_ALIASES: Record<string, string> = {
  'uk': 'GBR', 'u.k.': 'GBR', 'england': 'GBR', 'scotland': 'GBR', 'wales': 'GBR',
  'northern ireland': 'GBR', 'great britain': 'GBR', 'britain': 'GBR',
  'u.s.': 'USA', 'u.s.a.': 'USA', 'america': 'USA', 'the states': 'USA',
  'holland': 'NLD', 'the netherlands': 'NLD',
  'burma': 'MMR',
  'uae': 'ARE', 'emirates': 'ARE', 'the emirates': 'ARE',
  'swaziland': 'SWZ',
  'persia': 'IRN',
  'ceylon': 'LKA',
  'deutschland': 'DEU',
  'espana': 'ESP', 'españa': 'ESP',
  "cote d'ivoire": 'CIV', "côte d'ivoire": 'CIV', 'ivory coast': 'CIV',
  'east timor': 'TLS', 'timor-leste': 'TLS',
  'zaire': 'COD', 'drc': 'COD', 'dr congo': 'COD',
  'congo-brazzaville': 'COG',
  'turkiye': 'TUR', 'türkiye': 'TUR',
  'bharat': 'IND',
  'cabo verde': 'CPV',
  'macedonia': 'MKD', 'fyrom': 'MKD',
  'the vatican': 'VAT', 'vatican city': 'VAT', 'holy see': 'VAT',
  'south korea': 'KOR', 'north korea': 'PRK',
  'nippon': 'JPN',
  'suomi': 'FIN', 'sverige': 'SWE', 'norge': 'NOR',
};

async function resolveCountriesByName(query: string): Promise<CountryRecord[]> {
  const q = query.trim().toLowerCase();
  const matches = await findCountriesByName(query);

  // An exact common/official name is unambiguous — nothing below can improve it.
  const hasExact = matches.some(
    (c) => c.name.common.toLowerCase() === q || c.name.official.toLowerCase() === q,
  );
  if (hasExact) return matches;

  // A bare 2- or 3-letter query is an ISO code far more often than it is a
  // name fragment; findCountryByCode returns null when it isn't one, so a
  // genuine fragment like "New" still falls through to the substring pass.
  const byCode = /^[a-z]{2,3}$/.test(q) ? await findCountryByCode(q) : null;
  if (byCode) return [byCode];

  const alias = NAME_ALIASES[q];
  if (alias) {
    const aliased = await findCountryByCode(alias);
    if (aliased) return [aliased];
  }

  return matches;
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatLanguages(languages?: Record<string, string>): string[] {
  return languages ? Object.values(languages) : [];
}

function formatCurrencies(
  currencies?: Record<string, { name: string; symbol: string }>,
): string[] {
  if (!currencies) return [];
  return Object.values(currencies).map((c) => `${c.name} (${c.symbol})`);
}

/**
 * Land borders, resolved from alpha3 codes to names.
 *
 * The upstream record has always carried `borders` and the shaper dropped it,
 * so "which countries border Bolivia" answered no_match against a response that
 * held the answer (fleet #264). Codes alone would not have fixed it: a caller
 * asking that question wants "Argentina, Brazil, Chile, Paraguay, Peru", and an
 * agent that has to resolve five alpha3 codes with five more calls will usually
 * just not.
 *
 * An empty array is meaningful and is kept distinct from absent: [] means the
 * country genuinely has no land neighbours (an island), null means the upstream
 * did not say. Collapsing the two would turn "Japan borders nothing" into "we
 * don't know", or worse the reverse.
 */
async function resolveBorders(c: CountryRecord): Promise<{ codes: string[] | null; names: string[] | null }> {
  if (!c.borders) return { codes: null, names: null };
  const all = await loadCountries();
  const byAlpha3 = new Map(all.map((x) => [x.cca3, x.name.common]));
  return {
    codes: c.borders,
    // Fall back to the code when a neighbour is not in the dataset, rather than
    // silently shortening the list.
    names: c.borders.map((code) => byAlpha3.get(code) ?? code),
  };
}

async function summariseCountry(c: CountryRecord) {
  const borders = await resolveBorders(c);
  return {
    name: c.name.common,
    official_name: c.name.official,
    codes: { alpha2: c.cca2, alpha3: c.cca3 },
    capital: c.capital?.[0] ?? 'N/A',
    region: c.region,
    subregion: c.subregion ?? '',
    population: c.population,
    population_year: c.population_year ?? null,
    area_km2: c.area ?? null,
    languages: formatLanguages(c.languages),
    currencies: formatCurrencies(c.currencies),
    flag: c.flag ?? '',
    flag_image: c.flags.png,
    land_borders: borders.names,
    land_border_codes: borders.codes,
  };
}

function briefCountry(c: CountryRecord) {
  return {
    name: c.name.common,
    capital: c.capital?.[0] ?? 'N/A',
    population: c.population,
    flag: c.flag ?? '',
  };
}

function regionalCountry(c: CountryRecord) {
  return {
    name: c.name.common,
    capital: c.capital?.[0] ?? 'N/A',
    region: c.region,
    population: c.population,
  };
}

// ── Tool definitions ───────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'search_countries',
    description: 'Search for countries by name. Returns official name, capital, region, population, area, languages, currencies, flag emoji, and the country\'s land borders by name — so "which countries border Bolivia" is answerable directly.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Country name to search for (partial matches are supported)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_country_by_code',
    description: 'Get country details by ISO code (e.g., "US" for United States or "FRA" for France). Returns capital, population, languages, currencies, area, and region.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'ISO 3166-1 alpha-2 or alpha-3 country code' },
      },
      required: ['code'],
    },
  },
  {
    name: 'countries_by_region',
    description: 'List all countries in a region (e.g., "Africa", "Europe", "Asia"). Returns name, capital, population, area, and flag emoji.',
    inputSchema: {
      type: 'object',
      properties: {
        region: {
          type: 'string',
          description: 'Region name — one of: africa, americas, asia, europe, oceania',
        },
      },
      required: ['region'],
    },
  },
  {
    name: 'countries_by_language',
    description: 'Find countries where a language is spoken (e.g., "Spanish", "Mandarin"). Returns name, capital, region, population, and official language status.',
    inputSchema: {
      type: 'object',
      properties: {
        language: { type: 'string', description: 'Language name (e.g. "spanish", "french", "arabic")' },
      },
      required: ['language'],
    },
  },
  {
    name: 'countries_by_currency',
    description: 'Find countries using a currency (e.g., "EUR" for Euro, "USD" for US Dollar). Returns name, capital, region, and currency details.',
    inputSchema: {
      type: 'object',
      properties: {
        currency: { type: 'string', description: 'Currency code or name (e.g. "eur", "usd", "dollar")' },
      },
      required: ['currency'],
    },
  },
];

// ── Tool dispatch ──────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_countries': {
      const query = args.query as string | undefined;
      if (typeof query !== 'string' || !query.trim()) {
        throw new Error('Required argument "query" is missing. Pass a country name, e.g. {"query":"Estonia"}.');
      }
      const countries = await resolveCountriesByName(query);
      return { query, count: countries.length, results: await Promise.all(countries.map(summariseCountry)) };
    }

    case 'get_country_by_code': {
      const rawCode = args.code as string | undefined;
      if (typeof rawCode !== 'string' || !rawCode.trim()) {
        throw new Error('Required argument "code" is missing. Pass an ISO 3166-1 alpha-2 (e.g. "US") or alpha-3 (e.g. "FRA") country code.');
      }
      const country = await findCountryByCode(rawCode);
      if (!country) {
        return { found: false, code: rawCode, hint: 'No country found for that code. Pass a valid ISO 3166-1 alpha-2 or alpha-3 code.' };
      }
      return summariseCountry(country);
    }

    case 'countries_by_region': {
      const region = args.region as string | undefined;
      if (typeof region !== 'string' || !region.trim()) {
        throw new Error('Required argument "region" is missing. One of: Africa, Americas, Asia, Europe, Oceania (subregions such as "Northern Europe" also work).');
      }
      const countries = await findCountriesByRegion(region);
      return { region, count: countries.length, countries: countries.map(briefCountry) };
    }

    case 'countries_by_language': {
      const language = args.language as string | undefined;
      if (typeof language !== 'string' || !language.trim()) {
        throw new Error('Required argument "language" is missing. Pass a language name, e.g. {"language":"Spanish"}.');
      }
      const countries = await findCountriesByLanguage(language);
      return { language, count: countries.length, countries: countries.map(regionalCountry) };
    }

    case 'countries_by_currency': {
      const currency = args.currency as string | undefined;
      if (typeof currency !== 'string' || !currency.trim()) {
        throw new Error('Required argument "currency" is missing. Pass a currency code or name, e.g. {"currency":"EUR"}.');
      }
      const countries = await findCountriesByCurrency(currency);
      return {
        currency,
        count: countries.length,
        countries: countries.map((c) => ({
          name: c.name.common,
          capital: c.capital?.[0] ?? 'N/A',
          region: c.region,
        })),
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 2 } } satisfies McpToolExport;
