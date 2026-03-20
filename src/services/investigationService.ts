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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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
    const [spans, logs] = await Promise.all([
      this.backend.getTraceSpans(input.traceId, options),
      this.backend.getTraceLogs(input.traceId, options)
    ]);

    if (spans.length === 0 && logs.length === 0) {
      throw new Error(`No span or log records found for trace ${input.traceId}.`);
    }

    const systemsInvolved = servicesInChronologicalOrder(spans, logs);
    const evidence = flattenEvidence([], logs, spans);

    return {
      traceId: input.traceId,
      systemsInvolved,
      timeRange: timeRangeFromRecords(spans, logs),
      timeline: buildTimeline(spans, logs),
      summary: summarizeTrace(input.traceId, systemsInvolved, spans),
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

    const service = failedSpan?.service ?? errorLog?.service ?? systems[systems.length - 1] ?? "unknown";
    const reasonParts = [
      errorLog ? errorLog.message : undefined,
      failedSpan ? `${failedSpan.name} recorded an error span.` : undefined,
      missingService ? `No downstream ${missingService} span appears after ${service}.` : undefined
    ].filter((value): value is string => Boolean(value));
    const confidence =
      errorLog && missingService ? 0.96 : errorLog || failedSpan ? 0.88 : 0.7;

    const likelyFailurePoint = {
      service,
      reason: reasonParts.join(" "),
      lastSuccessfulStep: lastSuccessfulSpan
        ? `${lastSuccessfulSpan.service}: ${lastSuccessfulSpan.name}`
        : undefined,
      missingExpectedService: missingService,
      supportingLogIds: errorLog ? [errorLog.logId] : [],
      confidence
    };
    const evidence = flattenEvidence(bestCandidate.evidence, logs, spans);

    return {
      businessKey: input.businessKey,
      traceId: bestCandidate.traceId,
      likelyFailurePoint,
      confidence,
      summary: `The most likely failure point for ${input.businessKey.type}=${input.businessKey.value} is ${service}.`,
      evidence
    };
  }
}
