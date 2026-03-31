# @pipeworx/mcp-countries

MCP server for world country data — search by name, code, region, language, or currency.

## Tools

| Tool | Description |
|------|-------------|
| `search_countries` | Search for countries by name |
| `get_country_by_code` | Get country by ISO alpha-2 or alpha-3 code |
| `countries_by_region` | List all countries in a geographic region |
| `countries_by_language` | Find countries where a given language is spoken |
| `countries_by_currency` | Find countries that use a given currency |

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

Or run via CLI:

```bash
npx pipeworx use countries
```

## License

MIT
