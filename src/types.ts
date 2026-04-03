import { z } from "zod";

export const severitySchema = z.enum(["debug", "info", "warn", "error"]);
export type Severity = z.infer<typeof severitySchema>;

export const businessKeySchema = z.object({
  type: z.string().min(1),
  value: z.string().min(1)
});
export type BusinessKey = z.infer<typeof businessKeySchema>;

export const timeRangeSchema = z.object({
  start: z.string().datetime(),
  end: z.string().datetime()
});
export type TimeRange = z.infer<typeof timeRangeSchema>;

export const traceSpanSchema = z.object({
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  parentSpanId: z.string().min(1).optional(),
  service: z.string().min(1),
  name: z.string().min(1),
  timestamp: z.string().datetime(),
  durationMs: z.number().nonnegative().optional(),
  status: z.enum(["ok", "error"]).default("ok"),
  attributes: z.record(z.string(), z.string()).default({})
});
export type TraceSpanRecord = z.infer<typeof traceSpanSchema>;

export const traceLogSchema = z.object({
  logId: z.string().min(1),
  timestamp: z.string().datetime(),
  service: z.string().min(1),
  severity: severitySchema,
  message: z.string().min(1),
  traceId: z.string().min(1).optional(),
  spanId: z.string().min(1).optional(),
  attributes: z.record(z.string(), z.string()).default({})
});
export type TraceLogRecord = z.infer<typeof traceLogSchema>;

export const relatedEntitySchema = z.object({
  entityId: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  service: z.string().min(1)
});
export type RelatedEntity = z.infer<typeof relatedEntitySchema>;

export const evidenceItemSchema = z.object({
  kind: z.enum(["span", "log", "entity"]),
  id: z.string().min(1),
  timestamp: z.string().datetime().optional(),
  service: z.string().min(1).optional(),
  message: z.string().min(1),
  reason: z.string().min(1),
  matchedBy: z.string().min(1),
  severity: severitySchema.optional()
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const timelineEntrySchema = z.object({
  timestamp: z.string().datetime(),
  service: z.string().min(1),
  eventType: z.enum(["span", "log"]),
  message: z.string().min(1),
  traceId: z.string().min(1),
  spanId: z.string().min(1).optional(),
  parentSpanId: z.string().min(1).optional(),
  severity: severitySchema.optional(),
  matchedBy: z.string().min(1)
});
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

export const logEntrySchema = z.object({
  logId: z.string().min(1),
  timestamp: z.string().datetime(),
  service: z.string().min(1),
  severity: severitySchema,
  message: z.string().min(1),
  traceId: z.string().min(1).optional(),
  spanId: z.string().min(1).optional(),
  matchedBy: z.string().min(1)
});
export type LogEntry = z.infer<typeof logEntrySchema>;

export const traceMatchSchema = z.object({
  traceId: z.string().min(1),
  systemsInvolved: z.array(z.string().min(1)).min(1),
  timeRange: timeRangeSchema,
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
  evidence: z.array(evidenceItemSchema)
});
export type TraceMatch = z.infer<typeof traceMatchSchema>;

export const failurePointSchema = z.object({
  service: z.string().min(1),
  reason: z.string().min(1),
  lastSuccessfulStep: z.string().min(1).optional(),
  missingExpectedService: z.string().min(1).optional(),
  supportingLogIds: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1)
});
export type FailurePoint = z.infer<typeof failurePointSchema>;

export const findBusinessTracesResultSchema = z.object({
  businessKey: businessKeySchema,
  lookbackMinutes: z.number().int().positive(),
  matches: z.array(traceMatchSchema),
  summary: z.string().min(1)
});
export type FindBusinessTracesResult = z.infer<typeof findBusinessTracesResultSchema>;

export const getTraceTimelineResultSchema = z.object({
  traceId: z.string().min(1),
  systemsInvolved: z.array(z.string().min(1)).min(1),
  timeRange: timeRangeSchema,
  timeline: z.array(timelineEntrySchema),
  summary: z.string().min(1),
  evidence: z.array(evidenceItemSchema)
});
export type GetTraceTimelineResult = z.infer<typeof getTraceTimelineResultSchema>;

export const fetchBusinessLogsResultSchema = z.object({
  businessKey: businessKeySchema,
  traceIds: z.array(z.string().min(1)),
  logs: z.array(logEntrySchema),
  summary: z.string().min(1),
  evidence: z.array(evidenceItemSchema)
});
export type FetchBusinessLogsResult = z.infer<typeof fetchBusinessLogsResultSchema>;

export const explainFailurePointResultSchema = z.object({
  businessKey: businessKeySchema,
  traceId: z.string().min(1),
  failureDetected: z.boolean(),
  likelyFailurePoint: failurePointSchema,
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
  evidence: z.array(evidenceItemSchema)
});
export type ExplainFailurePointResult = z.infer<typeof explainFailurePointResultSchema>;

export const scenarioDocumentSchema = z.object({
  scenarioId: z.string().min(1),
  businessKey: businessKeySchema,
  traceId: z.string().min(1),
  summary: z.string().min(1),
  spans: z.array(traceSpanSchema),
  logs: z.array(traceLogSchema),
  entities: z.array(relatedEntitySchema)
});
export type ScenarioDocument = z.infer<typeof scenarioDocumentSchema>;

export type SearchTraceCandidate = {
  traceId: string;
  matchedBy: string[];
  evidence: EvidenceItem[];
  score: number;
  summary: string;
};

export type LookbackOptions = {
  lookbackMinutes: number;
};
