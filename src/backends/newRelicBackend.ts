import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { AppConfig } from "../config.js";
import type { InvestigationBackend } from "./backend.js";
import type {
  BusinessKey,
  LookbackOptions,
  RelatedEntity,
  SearchTraceCandidate,
  TraceLogRecord,
  TraceSpanRecord
} from "../types.js";

type NrqlResultRow = Record<string, unknown>;

function escapeNrqlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return new Date(value).toISOString();
  }

  return undefined;
}

function buildBusinessKeyWhereClause(
  businessKey: BusinessKey,
  businessKeyFieldCandidates: string[]
): string {
  const exactValue = escapeNrqlString(businessKey.value);
  const exactPair = escapeNrqlString(`${businessKey.type}=${businessKey.value}`);

  const clauses = businessKeyFieldCandidates.map((field) => {
    if (field === "message") {
      return `(message LIKE '%${exactPair}%' OR message LIKE '%${exactValue}%')`;
    }

    return `\`${field}\` = '${exactValue}'`;
  });

  return `(${clauses.join(" OR ")})`;
}

class NewRelicMcpHelper {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;

  public constructor(private readonly config: AppConfig["newRelic"]) {}

  private async getClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }

    const transport = new StreamableHTTPClientTransport(new URL(this.config.mcpUrl), {
      requestInit: {
        headers: {
          "api-key": this.config.userApiKey ?? "",
          "include-tags": this.config.includeTags.join(",")
        }
      }
    });
    const client = new Client(
      { name: "business-investigation-mcp-backend", version: "0.1.0" },
      { capabilities: {} }
    );

    await client.connect(transport);

    this.transport = transport;
    this.client = client;

    return client;
  }

  public async listAvailableAccounts(): Promise<unknown[]> {
    const client = await this.getClient();
    const result = await client.callTool({
      name: "list_available_new_relic_accounts",
      arguments: {}
    });
    const structuredContent =
      "structuredContent" in result ? (result.structuredContent as Record<string, unknown> | undefined) : undefined;

    if (structuredContent && Array.isArray(structuredContent.accounts)) {
      return structuredContent.accounts as unknown[];
    }

    return [];
  }
}

export class NewRelicBackend implements InvestigationBackend {
  private readonly remoteMcpHelper?: NewRelicMcpHelper;

  public constructor(private readonly config: AppConfig["newRelic"]) {
    if (config.mcpUrl) {
      this.remoteMcpHelper = new NewRelicMcpHelper(config);
    }
  }

  private async runNrql(query: string): Promise<NrqlResultRow[]> {
    const graphqlQuery = `
      query BusinessInvestigation($accountId: Int!, $query: Nrql!) {
        actor {
          account(id: $accountId) {
            nrql(query: $query) {
              results
            }
          }
        }
      }
    `;

    const response = await fetch(this.config.nerdGraphUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "API-Key": this.config.userApiKey ?? ""
      },
      body: JSON.stringify({
        query: graphqlQuery,
        variables: {
          accountId: Number(this.config.accountId),
          query
        }
      })
    });

    if (!response.ok) {
      throw new Error(`NerdGraph request failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as {
      data?: {
        actor?: {
          account?: {
            nrql?: {
              results?: NrqlResultRow[];
            };
          };
        };
      };
      errors?: Array<{ message?: string }>;
    };

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(payload.errors.map((error) => error.message ?? "Unknown error").join("; "));
    }

    return payload.data?.actor?.account?.nrql?.results ?? [];
  }

  private mapSpanRow(row: NrqlResultRow): TraceSpanRecord | undefined {
    const traceId = toStringValue(row["trace.id"]);
    const spanId = toStringValue(row.id) ?? toStringValue(row["span.id"]);
    const service = toStringValue(row["entity.name"]) ?? toStringValue(row.service);
    const name = toStringValue(row.name) ?? "span";
    const timestamp = toIsoTimestamp(row.timestamp);

    if (!traceId || !spanId || !service || !timestamp) {
      return undefined;
    }

    const attributes = Object.entries(row).reduce<Record<string, string>>((accumulator, [key, value]) => {
      const stringValue = toStringValue(value);
      if (stringValue) {
        accumulator[key] = stringValue;
      }
      return accumulator;
    }, {});

    return {
      traceId,
      spanId,
      parentSpanId: toStringValue(row["parent.id"]),
      service,
      name,
      timestamp,
      durationMs: typeof row["duration.ms"] === "number" ? row["duration.ms"] : undefined,
      status: row["error.message"] || row["error.class"] ? "error" : "ok",
      attributes
    };
  }

  private mapLogRow(row: NrqlResultRow): TraceLogRecord | undefined {
    const logId = toStringValue(row["entity.guid"]) ?? toStringValue(row["log.id"]) ?? randomUUID();
    const timestamp = toIsoTimestamp(row.timestamp);
    const service = toStringValue(row["entity.name"]) ?? toStringValue(row.service);
    const message = toStringValue(row.message);
    const severity = toStringValue(row.level)?.toLowerCase();

    if (!timestamp || !service || !message) {
      return undefined;
    }

    const normalizedSeverity =
      severity === "error" || severity === "warn" || severity === "info" || severity === "debug"
        ? severity
        : "info";

    const attributes = Object.entries(row).reduce<Record<string, string>>((accumulator, [key, value]) => {
      const stringValue = toStringValue(value);
      if (stringValue) {
        accumulator[key] = stringValue;
      }
      return accumulator;
    }, {});

    return {
      logId,
      timestamp,
      service,
      severity: normalizedSeverity,
      message,
      traceId: toStringValue(row["trace.id"]),
      spanId: toStringValue(row["span.id"]),
      attributes
    };
  }

  private async maybeValidateRemoteAccess(): Promise<void> {
    if (!this.remoteMcpHelper) {
      return;
    }

    try {
      await this.remoteMcpHelper.listAvailableAccounts();
    } catch {
      // Keep remote MCP integration best-effort so the main live path remains NerdGraph-first.
    }
  }

  public async searchByBusinessKey(
    businessKey: BusinessKey,
    options: LookbackOptions
  ): Promise<SearchTraceCandidate[]> {
    await this.maybeValidateRemoteAccess();

    const whereClause = buildBusinessKeyWhereClause(
      businessKey,
      this.config.businessKeyFieldCandidates
    );

    const spanQuery = `
      FROM Span
      SELECT trace.id, id, parent.id, entity.name, name, timestamp, duration.ms, error.message, error.class
      WHERE ${whereClause}
      SINCE ${options.lookbackMinutes} MINUTES AGO
      LIMIT 200
    `;

    const logQuery = `
      FROM Log
      SELECT trace.id, span.id, entity.name, message, level, timestamp
      WHERE ${whereClause}
      SINCE ${options.lookbackMinutes} MINUTES AGO
      LIMIT 200
    `;

    const [spanRows, logRows] = await Promise.all([this.runNrql(spanQuery), this.runNrql(logQuery)]);
    const grouped = new Map<string, SearchTraceCandidate>();

    for (const row of spanRows) {
      const span = this.mapSpanRow(row);
      if (!span) {
        continue;
      }

      const existing = grouped.get(span.traceId) ?? {
        traceId: span.traceId,
        matchedBy: [],
        evidence: [],
        score: 0,
        summary: `Matched spans for ${businessKey.type}=${businessKey.value}.`
      };

      existing.matchedBy = uniqueStrings([...existing.matchedBy, `span.attribute:${businessKey.type}`]);
      existing.evidence.push({
        kind: "span",
        id: span.spanId,
        timestamp: span.timestamp,
        service: span.service,
        message: span.name,
        reason: `Span attributes matched ${businessKey.type}=${businessKey.value}.`,
        matchedBy: `span.attribute:${businessKey.type}`
      });
      existing.score += 2;
      grouped.set(span.traceId, existing);
    }

    for (const row of logRows) {
      const log = this.mapLogRow(row);
      if (!log?.traceId) {
        continue;
      }

      const existing = grouped.get(log.traceId) ?? {
        traceId: log.traceId,
        matchedBy: [],
        evidence: [],
        score: 0,
        summary: `Matched logs for ${businessKey.type}=${businessKey.value}.`
      };

      const matchedBy = log.message.includes(`${businessKey.type}=${businessKey.value}`)
        ? "log.message"
        : `log.attribute:${businessKey.type}`;

      existing.matchedBy = uniqueStrings([...existing.matchedBy, matchedBy]);
      existing.evidence.push({
        kind: "log",
        id: log.logId,
        timestamp: log.timestamp,
        service: log.service,
        message: log.message,
        reason: `Log evidence matched ${businessKey.type}=${businessKey.value}.`,
        matchedBy,
        severity: log.severity
      });
      existing.score += matchedBy === "log.message" ? 1 : 2;
      grouped.set(log.traceId, existing);
    }

    return [...grouped.values()].sort((left, right) => right.score - left.score);
  }

  public async getTraceSpans(
    traceId: string,
    options: LookbackOptions
  ): Promise<TraceSpanRecord[]> {
    const query = `
      FROM Span
      SELECT trace.id, id, parent.id, entity.name, name, timestamp, duration.ms, error.message, error.class
      WHERE trace.id = '${escapeNrqlString(traceId)}'
      SINCE ${options.lookbackMinutes} MINUTES AGO
      LIMIT 500
    `;

    const rows = await this.runNrql(query);

    return rows
      .map((row) => this.mapSpanRow(row))
      .filter((value): value is TraceSpanRecord => Boolean(value))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  public async getTraceLogs(traceId: string, options: LookbackOptions): Promise<TraceLogRecord[]> {
    const query = `
      FROM Log
      SELECT trace.id, span.id, entity.name, message, level, timestamp
      WHERE trace.id = '${escapeNrqlString(traceId)}'
      SINCE ${options.lookbackMinutes} MINUTES AGO
      LIMIT 500
    `;

    const rows = await this.runNrql(query);

    return rows
      .map((row) => this.mapLogRow(row))
      .filter((value): value is TraceLogRecord => Boolean(value))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  public async getBusinessLogs(
    businessKey: BusinessKey,
    options: LookbackOptions
  ): Promise<TraceLogRecord[]> {
    const matches = await this.searchByBusinessKey(businessKey, options);
    const traceLogs = await Promise.all(
      matches.map((match) => this.getTraceLogs(match.traceId, options))
    );

    return traceLogs
      .flat()
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  public async getRelatedEntities(
    traceId: string,
    options: LookbackOptions
  ): Promise<RelatedEntity[]> {
    const spans = await this.getTraceSpans(traceId, options);
    const services = uniqueStrings(spans.map((span) => span.service));

    return services.map((service) => ({
      entityId: `service:${service.toLowerCase()}`,
      name: service,
      type: "SERVICE",
      service
    }));
  }
}
