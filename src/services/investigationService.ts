import type { InvestigationBackend } from "../backends/backend.js";
import type {
  BusinessKey,
  EvidenceItem,
  ExplainFailurePointResult,
  FetchBusinessLogsResult,
  FindBusinessTracesResult,
  GetTraceTimelineResult,
  LogEntry,
  LookbackOptions,
  SearchTraceCandidate,
  TimelineEntry,
  TimeRange,
  TraceLogRecord,
  TraceSpanRecord,
  TraceMatch
} from "../types.js";

const EXPECTED_REFERENCE_FLOW = ["APIM", "Solace", "MuleSoft", "ERP"] as const;
const COMMON_BUSINESS_KEY_TYPES = [
  "SalesOrder",
  "OrderId",
  "TransactionId",
  "CorrelationId"
] as const;

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeBusinessKeyType(type: string): string {
  const compact = type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

  switch (compact) {
    case "salesorder":
    case "sales":
      return "SalesOrder";
    case "orderid":
    case "order":
      return "OrderId";
    case "transactionid":
    case "transaction":
      return "TransactionId";
    case "correlationid":
    case "correlation":
      return "CorrelationId";
    default: {
      const words = type
        .split(/[^a-zA-Z0-9]+/)
        .map((word) => word.trim())
        .filter(Boolean);

      return words.length > 0
        ? words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("")
        : type;
    }
  }
}

function isLikelyBusinessKeyType(type: string): boolean {
  const compact = type.replace(/[^a-zA-Z]/g, "");

  return compact.length > 0 && !/[0-9]/.test(type);
}

function parseBusinessKeyReference(reference: string): BusinessKey | undefined {
  const trimmed = reference.trim();
  const withoutTracePrefix = trimmed.replace(/^trace[-:_\s]*/i, "");

  const explicitMatch = withoutTracePrefix.match(
    /([A-Za-z][A-Za-z0-9 _-]*)\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9_-]*)/
  );

  if (explicitMatch?.[1] && explicitMatch[2] && isLikelyBusinessKeyType(explicitMatch[1])) {
    return {
      type: normalizeBusinessKeyType(explicitMatch[1]),
      value: explicitMatch[2]
    };
  }

  const hyphenatedMatch = withoutTracePrefix.match(
    /([A-Za-z][A-Za-z0-9 _-]*?)[-_ ]+([A-Za-z0-9][A-Za-z0-9_-]*)$/
  );

  if (hyphenatedMatch?.[1] && hyphenatedMatch[2] && isLikelyBusinessKeyType(hyphenatedMatch[1])) {
    return {
      type: normalizeBusinessKeyType(hyphenatedMatch[1]),
      value: hyphenatedMatch[2]
    };
  }

  return undefined;
}

function extractLikelyBusinessValue(reference: string): string | undefined {
  const trimmed = reference.trim();
  const candidates = trimmed.split(/[^A-Za-z0-9]+/).filter(Boolean);

  if (!candidates || candidates.length === 0) {
    return undefined;
  }

  const last = candidates.at(-1);

  return last && /[0-9]/.test(last) ? last : undefined;
}

function buildTraceIdCandidates(reference: string): string[] {
  const trimmed = reference.trim();
  const withoutTracePrefix = trimmed.replace(/^trace[-:_\s]*/i, "");
  const candidates = [trimmed];
  const slug = slugify(withoutTracePrefix);

  if (slug.length > 0) {
    candidates.push(`trace-${slug}`);
  }

  return uniqueStrings(candidates.filter(Boolean));
}

function buildBusinessKeyGuesses(reference: string): BusinessKey[] {
  const parsed = parseBusinessKeyReference(reference);
  const likelyValue = extractLikelyBusinessValue(reference);
  const lowerReference = reference.toLowerCase();
  const guessedTypes = [...COMMON_BUSINESS_KEY_TYPES];

  if (lowerReference.includes("sales")) {
    guessedTypes.unshift("SalesOrder");
  }

  if (lowerReference.includes("order")) {
    guessedTypes.unshift("OrderId");
  }

  if (lowerReference.includes("corr")) {
    guessedTypes.unshift("CorrelationId");
  }

  const guesses = new Map<string, BusinessKey>();

  if (parsed) {
    guesses.set(`${parsed.type}:${parsed.value}`, parsed);
  }

  if (likelyValue) {
    for (const type of guessedTypes) {
      const guess = {
        type,
        value: likelyValue
      };
      guesses.set(`${guess.type}:${guess.value}`, guess);
    }
  }

  return [...guesses.values()];
}

function timeRangeFromRecords(spans: TraceSpanRecord[], logs: TraceLogRecord[]): TimeRange {
  const timestamps = [...spans.map((span) => span.timestamp), ...logs.map((log) => log.timestamp)].sort();

  if (timestamps.length === 0) {
    const fallback = new Date(0).toISOString();
    return { start: fallback, end: fallback };
  }

  return {
    start: timestamps[0] ?? new Date(0).toISOString(),
    end: timestamps[timestamps.length - 1] ?? new Date(0).toISOString()
  };
}

function servicesInChronologicalOrder(
  spans: TraceSpanRecord[],
  logs: TraceLogRecord[],
  fallbackEntities: string[] = []
): string[] {
  const ordered = [
    ...spans.map((span) => ({ timestamp: span.timestamp, service: span.service })),
    ...logs.map((log) => ({ timestamp: log.timestamp, service: log.service }))
  ]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .map((item) => item.service);

  return uniqueStrings(ordered.length > 0 ? ordered : fallbackEntities);
}

function confidenceFromCandidate(
  candidate: SearchTraceCandidate,
  systemsInvolved: string[]
): number {
  const value = 0.45 + candidate.matchedBy.length * 0.15 + systemsInvolved.length * 0.05;
  return Math.min(0.99, Number(value.toFixed(2)));
}

function compareEvidence(left: EvidenceItem, right: EvidenceItem): number {
  const leftTimestamp = left.timestamp ?? "";
  const rightTimestamp = right.timestamp ?? "";
  return leftTimestamp.localeCompare(rightTimestamp);
}

function buildTimeline(spans: TraceSpanRecord[], logs: TraceLogRecord[]): TimelineEntry[] {
  const spanEntries: TimelineEntry[] = spans.map((span) => ({
    timestamp: span.timestamp,
    service: span.service,
    eventType: "span",
    message:
      span.status === "error"
        ? `${span.name} failed.`
        : `${span.name} completed.`,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    severity: span.status === "error" ? "error" : "info",
    matchedBy: "trace.id"
  }));
  const logEntries: TimelineEntry[] = logs.map((log) => ({
    timestamp: log.timestamp,
    service: log.service,
    eventType: "log",
    message: log.message,
    traceId: log.traceId ?? "unknown-trace",
    spanId: log.spanId,
    severity: log.severity,
    matchedBy: "trace.id"
  }));

  return [...spanEntries, ...logEntries].sort((left, right) => {
    if (left.timestamp !== right.timestamp) {
      return left.timestamp.localeCompare(right.timestamp);
    }

    return left.eventType.localeCompare(right.eventType);
  });
}

function buildLogEntries(logs: TraceLogRecord[]): LogEntry[] {
  return logs
    .map((log) => ({
      logId: log.logId,
      timestamp: log.timestamp,
      service: log.service,
      severity: log.severity,
      message: log.message,
      traceId: log.traceId,
      spanId: log.spanId,
      matchedBy: log.traceId ? "trace.id" : "business-key"
    }))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function summarizeTrace(traceId: string, systemsInvolved: string[], spans: TraceSpanRecord[]): string {
  const flow = systemsInvolved.join(" -> ");
  const failedSpan = spans.find((span) => span.status === "error");

  if (failedSpan) {
    return `Trace ${traceId} reaches ${flow} and fails in ${failedSpan.service}.`;
  }

  return `Trace ${traceId} reaches ${flow} and completes successfully.`;
}

function flattenEvidence(
  candidateEvidence: EvidenceItem[],
  logs: TraceLogRecord[],
  spans: TraceSpanRecord[]
): EvidenceItem[] {
  const synthesizedLogEvidence = logs.map<EvidenceItem>((log) => ({
    kind: "log",
    id: log.logId,
    timestamp: log.timestamp,
    service: log.service,
    message: log.message,
    reason: "Log linked to the candidate trace.",
    matchedBy: "trace.id",
    severity: log.severity
  }));
  const synthesizedSpanEvidence = spans.map<EvidenceItem>((span) => ({
    kind: "span",
    id: span.spanId,
    timestamp: span.timestamp,
    service: span.service,
    message: span.name,
    reason: "Span linked to the candidate trace.",
    matchedBy: "trace.id"
  }));

  const deduped = new Map<string, EvidenceItem>();

  for (const item of [...candidateEvidence, ...synthesizedSpanEvidence, ...synthesizedLogEvidence]) {
    deduped.set(`${item.kind}:${item.id}`, item);
  }

  return [...deduped.values()].sort(compareEvidence);
}

function expectedMissingService(servicesInvolved: string[]): string | undefined {
  const lastObservedIndex = EXPECTED_REFERENCE_FLOW.reduce((bestIndex, service, index) => {
    return servicesInvolved.includes(service) ? index : bestIndex;
  }, -1);

  const nextIndex = lastObservedIndex + 1;
  return EXPECTED_REFERENCE_FLOW[nextIndex];
}

export class InvestigationService {
  public constructor(
    private readonly backend: InvestigationBackend,
    private readonly defaultLookbackMinutes: number
  ) {}

  private normalizeLookback(lookbackMinutes?: number): LookbackOptions {
    return {
      lookbackMinutes: lookbackMinutes ?? this.defaultLookbackMinutes
    };
  }

  private async buildTraceMatch(
    candidate: SearchTraceCandidate,
    options: LookbackOptions
  ): Promise<TraceMatch> {
    const [spans, logs, entities] = await Promise.all([
      this.backend.getTraceSpans(candidate.traceId, options),
      this.backend.getTraceLogs(candidate.traceId, options),
      this.backend.getRelatedEntities(candidate.traceId, options)
    ]);
    const systemsInvolved = servicesInChronologicalOrder(
      spans,
      logs,
      entities.map((entity) => entity.service)
    );

    return {
      traceId: candidate.traceId,
      systemsInvolved,
      timeRange: timeRangeFromRecords(spans, logs),
      confidence: confidenceFromCandidate(candidate, systemsInvolved),
      summary: candidate.summary || summarizeTrace(candidate.traceId, systemsInvolved, spans),
      evidence: flattenEvidence(candidate.evidence, logs, spans)
    };
  }

  private async fetchTraceRecords(
    traceId: string,
    options: LookbackOptions
  ): Promise<{ traceId: string; spans: TraceSpanRecord[]; logs: TraceLogRecord[] } | undefined> {
    const [spans, logs] = await Promise.all([
      this.backend.getTraceSpans(traceId, options),
      this.backend.getTraceLogs(traceId, options)
    ]);

    if (spans.length === 0 && logs.length === 0) {
      return undefined;
    }

    return { traceId, spans, logs };
  }

  private async resolveTraceReference(
    traceReference: string,
    options: LookbackOptions
  ): Promise<{ traceId: string; spans: TraceSpanRecord[]; logs: TraceLogRecord[] } | undefined> {
    for (const candidateTraceId of buildTraceIdCandidates(traceReference)) {
      const records = await this.fetchTraceRecords(candidateTraceId, options);

      if (records) {
        return records;
      }
    }

    for (const businessKey of buildBusinessKeyGuesses(traceReference)) {
      const matches = await this.backend.searchByBusinessKey(businessKey, options);
      const bestMatch = matches[0];

      if (!bestMatch) {
        continue;
      }

      const records = await this.fetchTraceRecords(bestMatch.traceId, options);

      if (records) {
        return records;
      }
    }

    return undefined;
  }

  public async findBusinessTraces(input: {
    businessKey: BusinessKey;
    lookbackMinutes?: number;
  }): Promise<FindBusinessTracesResult> {
    const options = this.normalizeLookback(input.lookbackMinutes);
    const candidates = await this.backend.searchByBusinessKey(input.businessKey, options);
    const matches = await Promise.all(
      candidates.map((candidate) => this.buildTraceMatch(candidate, options))
    );

    const summary =
      matches.length > 0
        ? `Found ${matches.length} candidate trace(s) for ${input.businessKey.type}=${input.businessKey.value}.`
        : `No trace evidence found for ${input.businessKey.type}=${input.businessKey.value}.`;

    return {
      businessKey: input.businessKey,
      lookbackMinutes: options.lookbackMinutes,
      matches,
      summary
    };
  }

  public async getTraceTimeline(input: {
    traceId: string;
    lookbackMinutes?: number;
  }): Promise<GetTraceTimelineResult> {
    const options = this.normalizeLookback(input.lookbackMinutes);
    const resolved = await this.resolveTraceReference(input.traceId, options);

    if (!resolved) {
      throw new Error(
        `No span or log records found for trace ${input.traceId}. Call find_business_traces first or pass a business-key-like reference such as SalesOrder=12345.`
      );
    }

    const { traceId, spans, logs } = resolved;

    const systemsInvolved = servicesInChronologicalOrder(spans, logs);
    const evidence = flattenEvidence([], logs, spans);

    return {
      traceId,
      systemsInvolved,
      timeRange: timeRangeFromRecords(spans, logs),
      timeline: buildTimeline(spans, logs),
      summary: summarizeTrace(traceId, systemsInvolved, spans),
      evidence
    };
  }

  public async fetchBusinessLogs(input: {
    businessKey: BusinessKey;
    lookbackMinutes?: number;
  }): Promise<FetchBusinessLogsResult> {
    const options = this.normalizeLookback(input.lookbackMinutes);
    const traces = await this.backend.searchByBusinessKey(input.businessKey, options);
    const directLogs = await this.backend.getBusinessLogs(input.businessKey, options);
    const traceLogs = await Promise.all(
      traces.map((trace) => this.backend.getTraceLogs(trace.traceId, options))
    );
    const deduped = new Map<string, TraceLogRecord>();

    for (const log of [...directLogs, ...traceLogs.flat()]) {
      deduped.set(log.logId, log);
    }

    const logs = buildLogEntries([...deduped.values()]);
    const evidence = logs.map<EvidenceItem>((log) => ({
      kind: "log",
      id: log.logId,
      timestamp: log.timestamp,
      service: log.service,
      message: log.message,
      reason: "Log linked directly or indirectly to the business transaction.",
      matchedBy: log.matchedBy,
      severity: log.severity
    }));

    return {
      businessKey: input.businessKey,
      traceIds: traces.map((trace) => trace.traceId),
      logs,
      summary: `Collected ${logs.length} log(s) related to ${input.businessKey.type}=${input.businessKey.value}.`,
      evidence
    };
  }

  public async explainFailurePoint(input: {
    businessKey: BusinessKey;
    lookbackMinutes?: number;
  }): Promise<ExplainFailurePointResult> {
    const options = this.normalizeLookback(input.lookbackMinutes);
    const candidates = await this.backend.searchByBusinessKey(input.businessKey, options);
    const bestCandidate = candidates[0];

    if (!bestCandidate) {
      throw new Error(
        `No candidate traces found for ${input.businessKey.type}=${input.businessKey.value}.`
      );
    }

    const [spans, logs] = await Promise.all([
      this.backend.getTraceSpans(bestCandidate.traceId, options),
      this.backend.getTraceLogs(bestCandidate.traceId, options)
    ]);
    const systems = servicesInChronologicalOrder(spans, logs);
    const errorLog = logs.find((log) => log.severity === "error");
    const failedSpan = spans.find((span) => span.status === "error");
    const lastSuccessfulSpan = [...spans]
      .filter((span) => span.status === "ok")
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
    const missingService = expectedMissingService(systems);
    const terminalService = systems[systems.length - 1] ?? "unknown";
    const failureDetected = Boolean(errorLog || failedSpan || missingService);

    const service = failureDetected
      ? failedSpan?.service ?? errorLog?.service ?? terminalService
      : terminalService;
    const reasonParts = [
      errorLog ? errorLog.message : undefined,
      failedSpan ? `${failedSpan.name} recorded an error span.` : undefined,
      missingService ? `No downstream ${missingService} span appears after ${service}.` : undefined
    ].filter((value): value is string => Boolean(value));
    const lastLog = [...logs].sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
    const reason = failureDetected
      ? reasonParts.join(" ")
      : systems.length > 0
        ? `No failure evidence detected. The trace reaches ${service} and completes successfully.`
        : "No failure evidence detected for the requested business transaction.";
    const confidence = failureDetected
      ? errorLog && missingService
        ? 0.96
        : 0.88
      : 0.95;

    const likelyFailurePoint = {
      service,
      reason,
      lastSuccessfulStep: lastSuccessfulSpan
        ? `${lastSuccessfulSpan.service}: ${lastSuccessfulSpan.name}`
        : undefined,
      missingExpectedService: failureDetected ? missingService : undefined,
      supportingLogIds: failureDetected
        ? errorLog
          ? [errorLog.logId]
          : []
        : lastLog
          ? [lastLog.logId]
          : [],
      confidence
    };
    const evidence = flattenEvidence(bestCandidate.evidence, logs, spans);

    return {
      businessKey: input.businessKey,
      traceId: bestCandidate.traceId,
      failureDetected,
      likelyFailurePoint,
      confidence,
      summary: failureDetected
        ? `The most likely failure point for ${input.businessKey.type}=${input.businessKey.value} is ${service}.`
        : `No failure point detected for ${input.businessKey.type}=${input.businessKey.value}. The flow completed successfully.`,
      evidence
    };
  }
}
