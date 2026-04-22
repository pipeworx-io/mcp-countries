# mcp-countries

Countries MCP — world country data from REST Countries API v3.1

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 250+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `search_countries` | Search for countries by name. Returns official name, capital, region, population, area, languages, currencies, and flag emoji. |
| `get_country_by_code` | Get country details by ISO code (e.g., "US" for United States or "FRA" for France). Returns capital, population, languages, currencies, area, and region. |
| `countries_by_region` | List all countries in a region (e.g., "Africa", "Europe", "Asia"). Returns name, capital, population, area, and flag emoji. |
| `countries_by_language` | Find countries where a language is spoken (e.g., "Spanish", "Mandarin"). Returns name, capital, region, population, and official language status. |
| `countries_by_currency` | Find countries using a currency (e.g., "EUR" for Euro, "USD" for US Dollar). Returns name, capital, region, and currency details. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "countries": {
      "url": "https://gateway.pipeworx.io/countries/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 250+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Countries data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
