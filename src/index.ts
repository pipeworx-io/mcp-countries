/**
 * Countries MCP — world country data from REST Countries API v3.1
 *
 * Tools:
 * - search_countries: Search countries by name
 * - get_country_by_code: Get country by ISO alpha-2 or alpha-3 code
 * - countries_by_region: List countries in a region
 * - countries_by_language: Find countries by spoken language
 * - countries_by_currency: Find countries using a currency
 */

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

const BASE_URL = 'https://restcountries.com/v3.1';

const FIELDS = 'name,capital,region,subregion,population,area,languages,currencies,flag,cca2,cca3,flags';

// -- Types --

interface RestCountry {
  name: { common: string; official: string };
  capital?: string[];
  region: string;
  subregion?: string;
  population: number;
  area?: number;
  languages?: Record<string, string>;
  currencies?: Record<string, { name: string; symbol: string }>;
  flag?: string;
  cca2: string;
  cca3: string;
  flags?: { png?: string; svg?: string };
}

// -- Helpers --

function formatLanguages(languages?: Record<string, string>): string[] {
  return languages ? Object.values(languages) : [];
}

function formatCurrencies(
  currencies?: Record<string, { name: string; symbol: string }>,
): string[] {
  if (!currencies) return [];
  return Object.values(currencies).map((c) => `${c.name} (${c.symbol})`);
}

async function fetchCountries(path: string): Promise<RestCountry[]> {
  const url = `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}fields=${FIELDS}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`REST Countries API error ${res.status}${text ? `: ${text}` : ''}`);
  }
  return res.json() as Promise<RestCountry[]>;
}

function summariseCountry(c: RestCountry) {
  return {
    name: c.name.common,
    official_name: c.name.official,
    codes: { alpha2: c.cca2, alpha3: c.cca3 },
    capital: c.capital?.[0] ?? 'N/A',
    region: c.region,
    subregion: c.subregion ?? '',
    population: c.population,
    area_km2: c.area ?? null,
    languages: formatLanguages(c.languages),
    currencies: formatCurrencies(c.currencies),
    flag: c.flag ?? '',
  };
}

function briefCountry(c: RestCountry) {
  return {
    name: c.name.common,
    capital: c.capital?.[0] ?? 'N/A',
    population: c.population,
    flag: c.flag ?? '',
  };
}

function regionalCountry(c: RestCountry) {
  return {
    name: c.name.common,
    capital: c.capital?.[0] ?? 'N/A',
    region: c.region,
    population: c.population,
  };
}

// -- Tool definitions --

const tools: McpToolExport['tools'] = [
  {
    name: 'search_countries',
    description: 'Search for countries by name. Returns common name, official name, capital, region, subregion, population, area, languages, currencies, and flag emoji.',
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
    description: 'Get full country information by ISO 3166-1 alpha-2 (e.g. "US") or alpha-3 (e.g. "USA") code.',
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
    description: 'List all countries in a geographic region with name, capital, population, and flag.',
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
    description: 'Find all countries where a given language is spoken. Returns name, capital, region, and population.',
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
    description: 'Find all countries that use a given currency. Returns name, capital, and region.',
    inputSchema: {
      type: 'object',
      properties: {
        currency: { type: 'string', description: 'Currency code or name (e.g. "eur", "usd", "dollar")' },
      },
      required: ['currency'],
    },
  },
];

// -- Tool dispatch --

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_countries': {
      const query = encodeURIComponent(args.query as string);
      const countries = await fetchCountries(`/name/${query}`);
      return { results: countries.map(summariseCountry) };
    }

    case 'get_country_by_code': {
      const code = encodeURIComponent(args.code as string);
      const countries = await fetchCountries(`/alpha/${code}`);
      // /alpha returns an array; pick the first entry
      return summariseCountry(countries[0]);
    }

    case 'countries_by_region': {
      const region = encodeURIComponent(args.region as string);
      const countries = await fetchCountries(`/region/${region}`);
      const sorted = countries.sort((a, b) => b.population - a.population);
      return { region: args.region, count: sorted.length, countries: sorted.map(briefCountry) };
    }

    case 'countries_by_language': {
      const language = encodeURIComponent(args.language as string);
      const countries = await fetchCountries(`/lang/${language}`);
      const sorted = countries.sort((a, b) => b.population - a.population);
      return { language: args.language, count: sorted.length, countries: sorted.map(regionalCountry) };
    }

    case 'countries_by_currency': {
      const currency = encodeURIComponent(args.currency as string);
      const countries = await fetchCountries(`/currency/${currency}`);
      const sorted = countries.sort((a, b) => a.name.common.localeCompare(b.name.common));
      return {
        currency: args.currency,
        count: sorted.length,
        countries: sorted.map((c) => ({
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

export default { tools, callTool } satisfies McpToolExport;
