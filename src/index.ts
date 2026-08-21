import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const SEC_HEADERS: HeadersInit = {
  "Accept": "application/json",
  "User-Agent": "free-investment-mcp/0.2 (https://github.com/sdonghee/free-investment-mcp)"
};

type CompanyTicker = {
  cik_str: number;
  ticker: string;
  title: string;
};

type YahooChartResponse = {
  chart: {
    result?: Array<{
      meta: {
        symbol?: string;
        currency?: string;
        regularMarketPrice?: number;
        regularMarketTime?: number;
        regularMarketChange?: number;
        regularMarketChangePercent?: number;
        exchangeName?: string;
        marketState?: string;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }> | null;
    error?: { description?: string } | null;
  };
};

type SecSubmissions = {
  name: string;
  cik: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
      form: string[];
      primaryDocument: string[];
      primaryDocDescription?: string[];
      items?: string[];
    };
  };
};

type WorldBankObservation = {
  date: string;
  value: number | null;
  country?: { id: string; value: string };
  indicator?: { id: string; value: string };
};

type ClinicalTrialsResponse = {
  studies?: unknown[];
  totalCount?: number;
};

function toolText(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }]
  };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown upstream error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function fetchJson<T>(url: string, headers: HeadersInit = {}): Promise<T> {
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error("Upstream request failed with HTTP " + response.status);
  }

  return (await response.json()) as T;
}

async function getCikForTicker(ticker: string): Promise<{ cik: string; companyName: string }> {
  const companies = await fetchJson<Record<string, CompanyTicker>>(
    "https://www.sec.gov/files/company_tickers.json",
    SEC_HEADERS
  );

  const normalizedTicker = ticker.trim().toUpperCase();
  const company = Object.values(companies).find(
    (entry) => entry.ticker.toUpperCase() === normalizedTicker
  );

  if (!company) {
    throw new Error("SEC ticker mapping did not find " + normalizedTicker);
  }

  return {
    cik: String(company.cik_str),
    companyName: company.title
  };
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "free-investment-mcp",
    version: "0.2.0"
  });

  server.registerTool(
    "get_stock_quote",
    {
      title: "Get stock quote",
      description:
        "Return the latest available quote from Yahoo Finance. This is research data, not investment advice.",
      inputSchema: {
        symbol: z.string().trim().min(1).max(20).describe("Ticker symbol, such as AAPL or 005930"),
        market: z.enum(["us", "kr"]).default("us").describe("Market suffix when the symbol has none")
      }
    },
    async ({ symbol, market }) => {
      try {
        const normalized = symbol.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, "");

        if (!normalized) {
          return toolError("Provide a valid ticker symbol.");
        }

        const yahooSymbol = normalized.includes(".")
          ? normalized
          : market === "kr"
            ? normalized + ".KS"
            : normalized;
        const url =
          "https://query1.finance.yahoo.com/v8/finance/chart/" +
          encodeURIComponent(yahooSymbol) +
          "?range=5d&interval=1d";
        const payload = await fetchJson<YahooChartResponse>(url, {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (compatible; free-investment-mcp/0.2)"
        });
        const result = payload.chart.result?.[0];

        if (!result) {
          return toolError(payload.chart.error?.description ?? "No quote was found for " + symbol + ".");
        }

        const quote = result.indicators?.quote?.[0];
        const latestClose =
          (quote?.close ?? []).filter((price): price is number => typeof price === "number").at(-1) ?? null;

        return toolText({
          source: "Yahoo Finance",
          symbol: result.meta.symbol ?? yahooSymbol,
          currency: result.meta.currency ?? null,
          price: result.meta.regularMarketPrice ?? latestClose,
          regularMarketChange: result.meta.regularMarketChange ?? null,
          regularMarketChangePercent: result.meta.regularMarketChangePercent ?? null,
          marketState: result.meta.marketState ?? null,
          exchange: result.meta.exchangeName ?? null,
          timestamp: result.meta.regularMarketTime
            ? new Date(result.meta.regularMarketTime * 1000).toISOString()
            : null,
          note: "Yahoo Finance data may be delayed or incomplete. Verify before making investment decisions."
        });
      } catch (error) {
        return toolError("Unable to retrieve the quote: " + errorMessage(error));
      }
    }
  );

  server.registerTool(
    "get_sec_company_filings",
    {
      title: "Get SEC company filings",
      description:
        "Look up recent SEC filings for a US-listed company using a ticker or CIK. Results are direct SEC filing metadata.",
      inputSchema: {
        ticker: z.string().trim().min(1).max(12).optional().describe("US ticker, such as MSFT"),
        cik: z.string().trim().regex(/^[0-9]{1,10}$/).optional().describe("SEC CIK number"),
        limit: z.number().int().min(1).max(40).default(10).describe("Number of filings to return")
      }
    },
    async ({ ticker, cik, limit }) => {
      try {
        let cikNumber: string;
        let companyName: string | undefined;

        if (cik) {
          cikNumber = cik;
        } else {
          if (!ticker) {
            return toolError("Provide either a ticker or a CIK.");
          }

          const company = await getCikForTicker(ticker);
          cikNumber = company.cik;
          companyName = company.companyName;
        }

        const paddedCik = cikNumber.padStart(10, "0");
        const submission = await fetchJson<SecSubmissions>(
          "https://data.sec.gov/submissions/CIK" + paddedCik + ".json",
          SEC_HEADERS
        );
        const recent = submission.filings.recent;
        const filingCount = Math.min(limit, recent.accessionNumber.length);
        const archiveCik = String(Number(cikNumber));

        const filings = Array.from({ length: filingCount }, (_, index) => {
          const accessionNumber = recent.accessionNumber[index];
          const primaryDocument = recent.primaryDocument[index];
          const accessionPath = accessionNumber.replace(/-/g, "");

          return {
            form: recent.form[index],
            filingDate: recent.filingDate[index],
            reportDate: recent.reportDate[index] || null,
            accessionNumber,
            items: recent.items?.[index] || null,
            description: recent.primaryDocDescription?.[index] || null,
            documentUrl: primaryDocument
              ? "https://www.sec.gov/Archives/edgar/data/" +
                archiveCik +
                "/" +
                accessionPath +
                "/" +
                primaryDocument
              : null
          };
        });

        return toolText({
          source: "U.S. Securities and Exchange Commission",
          company: companyName ?? submission.name,
          cik: submission.cik,
          filings
        });
      } catch (error) {
        return toolError("Unable to retrieve SEC filings: " + errorMessage(error));
      }
    }
  );

  server.registerTool(
    "get_world_bank_indicator",
    {
      title: "Get macroeconomic indicator",
      description:
        "Return recent World Bank observations for a country and indicator code. No API key is required.",
      inputSchema: {
        country: z.string().trim().min(2).max(3).default("USA").describe("ISO country code, such as USA or KOR"),
        indicator: z
          .string()
          .trim()
          .min(3)
          .default("NY.GDP.MKTP.CD")
          .describe("World Bank indicator code, such as NY.GDP.MKTP.CD"),
        observations: z.number().int().min(1).max(50).default(10).describe("Number of non-empty observations")
      }
    },
    async ({ country, indicator, observations }) => {
      try {
        const url =
          "https://api.worldbank.org/v2/country/" +
          encodeURIComponent(country.toUpperCase()) +
          "/indicator/" +
          encodeURIComponent(indicator.toUpperCase()) +
          "?format=json&per_page=100";
        const payload = await fetchJson<[unknown, WorldBankObservation[]]>(url);
        const rows = Array.isArray(payload[1]) ? payload[1] : [];
        const values = rows
          .filter((row) => row.value !== null)
          .slice(0, observations)
          .map((row) => ({
            year: row.date,
            value: row.value,
            country: row.country?.value,
            indicator: row.indicator?.value
          }));

        if (values.length === 0) {
          return toolError("No World Bank observations were found for that country and indicator.");
        }

        return toolText({
          source: "World Bank Open Data",
          country: country.toUpperCase(),
          indicator: indicator.toUpperCase(),
          observations: values
        });
      } catch (error) {
        return toolError("Unable to retrieve macroeconomic data: " + errorMessage(error));
      }
    }
  );

  server.registerTool(
    "search_clinical_trials",
    {
      title: "Search clinical trials",
      description:
        "Search ClinicalTrials.gov for studies matching a disease, drug, company, or research term.",
      inputSchema: {
        query: z.string().trim().min(2).max(200).describe("Search term, such as pancreatic cancer or CRISPR"),
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum studies to return")
      }
    },
    async ({ query, limit }) => {
      try {
        const url =
          "https://clinicaltrials.gov/api/v2/studies?format=json&pageSize=" +
          limit +
          "&query.term=" +
          encodeURIComponent(query);
        const payload = await fetchJson<ClinicalTrialsResponse>(url);
        const studies = Array.isArray(payload.studies) ? payload.studies : [];

        const results = studies.map((study) => {
          const protocol = asRecord(asRecord(study).protocolSection);
          const identification = asRecord(protocol.identificationModule);
          const status = asRecord(protocol.statusModule);
          const design = asRecord(protocol.designModule);
          const startDate = asRecord(status.startDateStruct);

          return {
            nctId: asString(identification.nctId),
            title: asString(identification.briefTitle) ?? asString(identification.officialTitle),
            status: asString(status.overallStatus),
            studyType: asString(design.studyType),
            startDate: asString(startDate.date),
            lastUpdated: asString(status.lastUpdatePostDateStruct && asRecord(status.lastUpdatePostDateStruct).date),
            url: asString(identification.nctId)
              ? "https://clinicaltrials.gov/study/" + asString(identification.nctId)
              : null
          };
        });

        return toolText({
          source: "ClinicalTrials.gov",
          query,
          totalCount: payload.totalCount ?? null,
          studies: results
        });
      } catch (error) {
        return toolError("Unable to search clinical trials: " + errorMessage(error));
      }
    }
  );

  return server;
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, MCP-Protocol-Version");
  headers.set("Access-Control-Expose-Headers", "Mcp-Session-Id");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function handleMcpRequest(request: Request): Promise<Response> {
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  try {
    await server.connect(transport);
    return withCors(await transport.handleRequest(request));
  } catch (error) {
    return withCors(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
            data: errorMessage(error)
          },
          id: null
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        }
      )
    );
  } finally {
    await server.close();
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }));
      }

      return handleMcpRequest(request);
    }

    return withCors(
      new Response(
        JSON.stringify({
          name: "free-investment-mcp",
          status: "online",
          endpoint: "/mcp",
          tools: [
            "get_stock_quote",
            "get_sec_company_filings",
            "get_world_bank_indicator",
            "search_clinical_trials"
          ]
        }),
        {
          headers: { "Content-Type": "application/json; charset=utf-8" }
        }
      )
    );
  }
};
