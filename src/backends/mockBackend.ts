import { readFileSync } from "node:fs";
import path from "node:path";

import type { InvestigationBackend } from "./backend.js";
import {
  scenarioDocumentSchema,
  type BusinessKey,
  type EvidenceItem,
  type LookbackOptions,
  type RelatedEntity,
  type ScenarioDocument,
  type SearchTraceCandidate,
  type TraceLogRecord,
  type TraceSpanRecord
} from "../types.js";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function messageContainsBusinessKey(message: string, businessKey: BusinessKey): boolean {
  const normalizedMessage = normalize(message);
  const exactPair = `${normalize(businessKey.type)}=${normalize(businessKey.value)}`;
  return (
    normalizedMessage.includes(exactPair) ||
    normalizedMessage.includes(normalize(businessKey.value))
  );
}

function attributesMatchBusinessKey(
  attributes: Record<string, string>,
  businessKey: BusinessKey
): boolean {
  return Object.entries(attributes).some(
    ([key, value]) =>
      normalize(key) === normalize(businessKey.type) &&
      normalize(value) === normalize(businessKey.value)
  );
}

function spanEvidence(span: TraceSpanRecord, businessKey: BusinessKey): EvidenceItem {
  return {
    kind: "span",
    id: span.spanId,
    timestamp: span.timestamp,
    service: span.service,
    message: span.name,
    reason: `Span attributes matched ${businessKey.type}=${businessKey.value}.`,
    matchedBy: `span.attribute:${businessKey.type}`
  };
}

function logEvidence(
  log: TraceLogRecord,
  businessKey: BusinessKey,
  matchedBy: string
): EvidenceItem {
  return {
    kind: "log",
    id: log.logId,
    timestamp: log.timestamp,
    service: log.service,
    message: log.message,
    reason:
      matchedBy === "log.message"
        ? `Log message referenced ${businessKey.type}=${businessKey.value}.`
        : `Log attributes matched ${businessKey.type}=${businessKey.value}.`,
    matchedBy,
    severity: log.severity
  };
}

export class MockBackend implements InvestigationBackend {
  private readonly scenariosByTraceId: Map<string, ScenarioDocument>;

  public constructor(private readonly scenarios: ScenarioDocument[]) {
    this.scenariosByTraceId = new Map(scenarios.map((scenario) => [scenario.traceId, scenario]));
  }

  public static fromSampleData(rootDir = process.cwd()): MockBackend {
    const sampleFiles = [
      path.resolve(rootDir, "sample-data/success-flow.json"),
      path.resolve(rootDir, "sample-data/failure-flow.json")
    ];

    const scenarios = sampleFiles.map((filePath) => {
      const fileContents = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(fileContents) as unknown;
      return scenarioDocumentSchema.parse(parsed);
    });

    return new MockBackend(scenarios);
  }

  public searchByBusinessKey(
    businessKey: BusinessKey,
    _options: LookbackOptions
  ): Promise<SearchTraceCandidate[]> {
    const candidates: SearchTraceCandidate[] = [];

    for (const scenario of this.scenarios) {
      const evidence: EvidenceItem[] = [];
      const matchedBy = new Set<string>();

      if (
        normalize(scenario.businessKey.type) === normalize(businessKey.type) &&
        normalize(scenario.businessKey.value) === normalize(businessKey.value)
      ) {
        matchedBy.add("scenario.businessKey");
      }

      for (const span of scenario.spans) {
        if (attributesMatchBusinessKey(span.attributes, businessKey)) {
          evidence.push(spanEvidence(span, businessKey));
          matchedBy.add(`span.attribute:${businessKey.type}`);
        }
      }

      for (const log of scenario.logs) {
        if (attributesMatchBusinessKey(log.attributes, businessKey)) {
          evidence.push(logEvidence(log, businessKey, `log.attribute:${businessKey.type}`));
          matchedBy.add(`log.attribute:${businessKey.type}`);
        } else if (messageContainsBusinessKey(log.message, businessKey)) {
          evidence.push(logEvidence(log, businessKey, "log.message"));
          matchedBy.add("log.message");
        }
      }

      if (matchedBy.size > 0) {
        candidates.push({
          traceId: scenario.traceId,
          matchedBy: [...matchedBy],
          evidence,
          score: evidence.length + matchedBy.size,
          summary: scenario.summary
        });
      }
    }

    return Promise.resolve(candidates.sort((left, right) => right.score - left.score));
  }

  public getTraceSpans(
    traceId: string,
    _options: LookbackOptions
  ): Promise<TraceSpanRecord[]> {
    return Promise.resolve([...(this.scenariosByTraceId.get(traceId)?.spans ?? [])]);
  }

  public getTraceLogs(traceId: string, _options: LookbackOptions): Promise<TraceLogRecord[]> {
    return Promise.resolve([...(this.scenariosByTraceId.get(traceId)?.logs ?? [])]);
  }

  public async getBusinessLogs(
    businessKey: BusinessKey,
    options: LookbackOptions
  ): Promise<TraceLogRecord[]> {
    const matches = await this.searchByBusinessKey(businessKey, options);
    const logs = matches.flatMap((match) => this.scenariosByTraceId.get(match.traceId)?.logs ?? []);

    return logs.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  public getRelatedEntities(
    traceId: string,
    _options: LookbackOptions
  ): Promise<RelatedEntity[]> {
    return Promise.resolve([...(this.scenariosByTraceId.get(traceId)?.entities ?? [])]);
  }
}
