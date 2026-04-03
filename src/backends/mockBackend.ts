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

function businessKeyCacheKey(businessKey: BusinessKey): string {
  return `${normalize(businessKey.type)}:${normalize(businessKey.value)}`;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stableHash(value: string): number {
  let hash = 0;

  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return hash;
}

function replaceTemplateBusinessKey(
  value: string,
  templateBusinessKey: BusinessKey,
  targetBusinessKey: BusinessKey
): string {
  return value
    .replaceAll(
      `${templateBusinessKey.type}=${templateBusinessKey.value}`,
      `${targetBusinessKey.type}=${targetBusinessKey.value}`
    )
    .replaceAll(templateBusinessKey.type, targetBusinessKey.type)
    .replaceAll(templateBusinessKey.value, targetBusinessKey.value);
}

function inferScenarioKind(template: ScenarioDocument): "success" | "failure" {
  return template.scenarioId.includes("failure") ? "failure" : "success";
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
  private readonly templateByKind: Record<"success" | "failure", ScenarioDocument>;
  private readonly scenariosByBusinessKey = new Map<string, ScenarioDocument>();
  private readonly scenariosByTraceId: Map<string, ScenarioDocument>;

  public constructor(private readonly templates: ScenarioDocument[]) {
    const successTemplate = templates.find((template) => inferScenarioKind(template) === "success");
    const failureTemplate = templates.find((template) => inferScenarioKind(template) === "failure");

    if (!successTemplate || !failureTemplate) {
      throw new Error("MockBackend requires one success template and one failure template.");
    }

    this.templateByKind = {
      success: successTemplate,
      failure: failureTemplate
    };
    this.scenariosByTraceId = new Map();

    for (const template of templates) {
      const generatedScenario = this.generateScenario(template, template.businessKey);
      this.cacheScenario(generatedScenario);
    }
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

  private cacheScenario(scenario: ScenarioDocument): ScenarioDocument {
    this.scenariosByBusinessKey.set(businessKeyCacheKey(scenario.businessKey), scenario);
    this.scenariosByTraceId.set(scenario.traceId, scenario);
    return scenario;
  }

  private pickTemplate(businessKey: BusinessKey): ScenarioDocument {
    const explicitTemplate = this.templates.find(
      (template) =>
        normalize(template.businessKey.type) === normalize(businessKey.type) &&
        normalize(template.businessKey.value) === normalize(businessKey.value)
    );

    if (explicitTemplate) {
      return explicitTemplate;
    }

    const hash = stableHash(`${businessKey.type}:${businessKey.value}`);

    return hash % 4 === 0 ? this.templateByKind.failure : this.templateByKind.success;
  }

  private generateScenario(
    template: ScenarioDocument,
    businessKey: BusinessKey
  ): ScenarioDocument {
    const scenarioKind = inferScenarioKind(template);
    const keySlug = slugify(`${businessKey.type}-${businessKey.value}`);
    const valueSlug = slugify(businessKey.value);
    const correlationId = `corr-${valueSlug}`;
    const traceId = `trace-${keySlug}`;
    const templateStart = new Date(template.spans[0]?.timestamp ?? Date.now()).getTime();
    const offsetMinutes = 10 + (stableHash(`${businessKey.type}:${businessKey.value}`) % 90);
    const anchorTimestamp = Date.now() - offsetMinutes * 60_000;
    const spanIdMap = new Map<string, string>();

    template.spans.forEach((span, index) => {
      spanIdMap.set(span.spanId, `span-${slugify(span.service)}-${valueSlug}-${index + 1}`);
    });

    const spans: TraceSpanRecord[] = template.spans.map((span, index) => {
      const timestamp =
        anchorTimestamp + (new Date(span.timestamp).getTime() - templateStart);
      const attributes: Record<string, string> = {};

      for (const [key, value] of Object.entries(span.attributes)) {
        if (normalize(key) === normalize(template.businessKey.type)) {
          continue;
        }

        if (key === "correlationId") {
          attributes[key] = correlationId;
          continue;
        }

        attributes[key] = replaceTemplateBusinessKey(value, template.businessKey, businessKey);
      }

      attributes[businessKey.type] = businessKey.value;
      attributes.correlationId = correlationId;

      return {
        traceId,
        spanId: spanIdMap.get(span.spanId) ?? `span-${valueSlug}-${index + 1}`,
        parentSpanId: span.parentSpanId ? spanIdMap.get(span.parentSpanId) : undefined,
        service: span.service,
        name: replaceTemplateBusinessKey(span.name, template.businessKey, businessKey),
        timestamp: new Date(timestamp).toISOString(),
        durationMs: span.durationMs,
        status: span.status,
        attributes
      };
    });

    const logs: TraceLogRecord[] = template.logs.map((log, index) => {
      const timestamp =
        anchorTimestamp + (new Date(log.timestamp).getTime() - templateStart);
      const attributes: Record<string, string> = {};

      for (const [key, value] of Object.entries(log.attributes)) {
        if (normalize(key) === normalize(template.businessKey.type)) {
          continue;
        }

        if (key === "correlationId") {
          attributes[key] = correlationId;
          continue;
        }

        attributes[key] = replaceTemplateBusinessKey(value, template.businessKey, businessKey);
      }

      attributes[businessKey.type] = businessKey.value;
      attributes.correlationId = correlationId;

      return {
        logId: `log-${slugify(log.service)}-${valueSlug}-${index + 1}`,
        timestamp: new Date(timestamp).toISOString(),
        service: log.service,
        severity: log.severity,
        message: replaceTemplateBusinessKey(log.message, template.businessKey, businessKey),
        traceId,
        spanId: log.spanId ? spanIdMap.get(log.spanId) : undefined,
        attributes
      };
    });

    const entities: RelatedEntity[] = template.entities.map((entity) => ({
      ...entity,
      entityId: `entity-${slugify(entity.service)}`
    }));

    const summary =
      scenarioKind === "failure"
        ? `${businessKey.type} ${businessKey.value} is fake demo data and stops in MuleSoft before ERP.`
        : `${businessKey.type} ${businessKey.value} is fake demo data and completes successfully from APIM to ERP.`;

    return {
      scenarioId: `${scenarioKind}-generated-${keySlug}`,
      businessKey,
      traceId,
      summary,
      spans,
      logs,
      entities
    };
  }

  private ensureScenarioForBusinessKey(businessKey: BusinessKey): ScenarioDocument {
    const cached = this.scenariosByBusinessKey.get(businessKeyCacheKey(businessKey));

    if (cached) {
      return cached;
    }

    const generated = this.generateScenario(this.pickTemplate(businessKey), businessKey);
    return this.cacheScenario(generated);
  }

  public searchByBusinessKey(
    businessKey: BusinessKey,
    _options: LookbackOptions
  ): Promise<SearchTraceCandidate[]> {
    const scenario = this.ensureScenarioForBusinessKey(businessKey);
    const candidates: SearchTraceCandidate[] = [];

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
    this.ensureScenarioForBusinessKey(businessKey);
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
