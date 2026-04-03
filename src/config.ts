import { z } from "zod";

const DEFAULT_PORT = 3000;
const DEFAULT_LOOKBACK_MINUTES = 120;
const DEFAULT_INCLUDE_TAGS = ["discovery", "data-access"] as const;
const DEFAULT_FIELD_CANDIDATES = [
  "salesOrder",
  "orderId",
  "businessKey",
  "correlationId",
  "message"
] as const;

const rawEnvSchema = z.object({
  BACKEND_MODE: z.enum(["mock", "newrelic"]).optional(),
  MCP_API_KEY: z.string().optional(),
  NEW_RELIC_REGION: z.enum(["US", "EU"]).optional(),
  NEW_RELIC_USER_API_KEY: z.string().optional(),
  NEW_RELIC_ACCOUNT_ID: z.string().optional(),
  NEW_RELIC_MCP_URL: z.string().optional(),
  NEW_RELIC_INCLUDE_TAGS: z.string().optional(),
  DEFAULT_LOOKBACK_MINUTES: z.string().optional(),
  BUSINESS_KEY_FIELD_CANDIDATES: z.string().optional(),
  PORT: z.string().optional()
});

export type BackendMode = "mock" | "newrelic";
export type NewRelicRegion = "US" | "EU";

export type AppConfig = {
  serverName: string;
  serverVersion: string;
  port: number;
  defaultLookbackMinutes: number;
  backendMode: BackendMode;
  auth: {
    apiKey?: string;
  };
  newRelic: {
    region: NewRelicRegion;
    userApiKey?: string;
    accountId?: string;
    mcpUrl: string;
    includeTags: string[];
    businessKeyFieldCandidates: string[];
    nerdGraphUrl: string;
  };
};

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseCsv(value: string | undefined, fallback: readonly string[]): string[] {
  if (!value) {
    return [...fallback];
  }

  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : [...fallback];
}

function defaultMcpUrl(region: NewRelicRegion): string {
  return region === "EU"
    ? "https://mcp.eu.newrelic.com/mcp/"
    : "https://mcp.newrelic.com/mcp/";
}

export function resolveNerdGraphUrl(region: NewRelicRegion): string {
  return region === "EU"
    ? "https://api.eu.newrelic.com/graphql"
    : "https://api.newrelic.com/graphql";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = rawEnvSchema.parse(env);
  const backendMode = raw.BACKEND_MODE ?? "mock";
  const region = raw.NEW_RELIC_REGION ?? "US";

  const config: AppConfig = {
    serverName: "business-investigation-mcp",
    serverVersion: "0.1.0",
    port: parsePositiveInteger(raw.PORT, DEFAULT_PORT),
    defaultLookbackMinutes: parsePositiveInteger(
      raw.DEFAULT_LOOKBACK_MINUTES,
      DEFAULT_LOOKBACK_MINUTES
    ),
    backendMode,
    auth: {
      apiKey: raw.MCP_API_KEY?.trim() || undefined
    },
    newRelic: {
      region,
      userApiKey: raw.NEW_RELIC_USER_API_KEY?.trim() || undefined,
      accountId: raw.NEW_RELIC_ACCOUNT_ID?.trim() || undefined,
      mcpUrl: raw.NEW_RELIC_MCP_URL?.trim() || defaultMcpUrl(region),
      includeTags: parseCsv(raw.NEW_RELIC_INCLUDE_TAGS, DEFAULT_INCLUDE_TAGS),
      businessKeyFieldCandidates: parseCsv(
        raw.BUSINESS_KEY_FIELD_CANDIDATES,
        DEFAULT_FIELD_CANDIDATES
      ),
      nerdGraphUrl: resolveNerdGraphUrl(region)
    }
  };

  if (
    backendMode === "newrelic" &&
    (!config.newRelic.userApiKey || !config.newRelic.accountId)
  ) {
    throw new Error(
      "BACKEND_MODE=newrelic requires NEW_RELIC_USER_API_KEY and NEW_RELIC_ACCOUNT_ID."
    );
  }

  return config;
}
