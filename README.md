# free-investment-mcp

A free, no-key MCP server for public investment research. It runs as a Cloudflare Worker and exposes a Streamable HTTP endpoint at `/mcp`.

## Included research tools

| Tool | Data source | What it does |
| --- | --- | --- |
| `get_stock_quote` | Stooq | Retrieves the latest available US or Korean end-of-day/delayed quote |
| `get_sec_company_filings` | U.S. SEC EDGAR | Finds a company's recent SEC filings by ticker or CIK |
| `get_world_bank_indicator` | World Bank Open Data | Returns recent macroeconomic observations by country and indicator |
| `search_clinical_trials` | ClinicalTrials.gov | Searches trial metadata by disease, drug, company, or research term |

The service only accesses public sources and does not require API keys. Market data can be delayed, unavailable, or incomplete; use it for research and verify material facts before making investment decisions.

## Deploy to Cloudflare

```bash
npm install
npm run check
npm run deploy
```

After deploying, your MCP URL is:

```text
https://<your-worker-subdomain>/mcp
```

Use that address when adding a remote MCP connector.

## Examples

- `get_stock_quote`: `symbol = AAPL`, `market = us`
- `get_sec_company_filings`: `ticker = NVDA`, `limit = 10`
- `get_world_bank_indicator`: `country = KOR`, `indicator = NY.GDP.MKTP.CD`
- `search_clinical_trials`: `query = pancreatic cancer`

## Development notes

- The Worker uses the MCP TypeScript SDK's stateless Streamable HTTP transport.
- All requests are read-only. No brokerage, account, or trading actions are included.
- The SEC asks automated clients to identify themselves. This server identifies itself with this repository URL.
