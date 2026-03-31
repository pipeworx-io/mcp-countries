# mcp-countries

Countries MCP — world country data from REST Countries API v3.1

Part of the [Pipeworx](https://pipeworx.io) open MCP gateway.

## Tools

| Tool | Description |
|------|-------------|
| `search_countries` | Search for countries by name. Returns common name, official name, capital, region, subregion, population, area, languages, currencies, and flag emoji. |
| `get_country_by_code` | Get full country information by ISO 3166-1 alpha-2 (e.g. "US") or alpha-3 (e.g. "USA") code. |
| `countries_by_region` | List all countries in a geographic region with name, capital, population, and flag. |
| `countries_by_language` | Find all countries where a given language is spoken. Returns name, capital, region, and population. |
| `countries_by_currency` | Find all countries that use a given currency. Returns name, capital, and region. |

## Quick Start

Add to your MCP client config:

```json
{
  "mcpServers": {
    "countries": {
      "url": "https://gateway.pipeworx.io/countries/mcp"
    }
  }
}
```

Or use the CLI:

```bash
npx pipeworx use countries
```

## License

MIT
