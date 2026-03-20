import type {
  BusinessKey,
  LookbackOptions,
  RelatedEntity,
  SearchTraceCandidate,
  TraceLogRecord,
  TraceSpanRecord
} from "../types.js";

export interface InvestigationBackend {
  searchByBusinessKey(
    businessKey: BusinessKey,
    options: LookbackOptions
  ): Promise<SearchTraceCandidate[]>;
  getTraceSpans(traceId: string, options: LookbackOptions): Promise<TraceSpanRecord[]>;
  getTraceLogs(traceId: string, options: LookbackOptions): Promise<TraceLogRecord[]>;
  getBusinessLogs(
    businessKey: BusinessKey,
    options: LookbackOptions
  ): Promise<TraceLogRecord[]>;
  getRelatedEntities(traceId: string, options: LookbackOptions): Promise<RelatedEntity[]>;
}
