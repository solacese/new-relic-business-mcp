import { describe, expect, it } from "vitest";

import { MockBackend } from "../src/backends/mockBackend.js";
import { InvestigationService } from "../src/services/investigationService.js";

function createService(): InvestigationService {
  return new InvestigationService(MockBackend.fromSampleData(), 120);
}

describe("InvestigationService", () => {
  it("find_business_traces returns the expected trace for SalesOrder=12345", async () => {
    const service = createService();

    const result = await service.findBusinessTraces({
      businessKey: {
        type: "SalesOrder",
        value: "12345"
      }
    });

    expect(result.matches[0]?.traceId).toBe("trace-salesorder-12345");
  });

  it("get_trace_timeline returns ordered systems for the success flow", async () => {
    const service = createService();

    const result = await service.getTraceTimeline({
      traceId: "trace-salesorder-12345"
    });

    expect(result.systemsInvolved).toEqual(["APIM", "Solace", "MuleSoft", "ERP"]);
    expect(result.timeline[0]?.service).toBe("APIM");
    expect(result.timeline.at(-1)?.service).toBe("ERP");
  });

  it("fetch_business_logs returns the expected error log for SalesOrder=98421", async () => {
    const service = createService();

    const result = await service.fetchBusinessLogs({
      businessKey: {
        type: "SalesOrder",
        value: "98421"
      }
    });

    expect(
      result.logs.some(
        (log) =>
          log.service === "MuleSoft" &&
          log.severity === "error" &&
          log.message.includes("Transformation failed")
      )
    ).toBe(true);
  });

  it("explain_failure_point identifies MuleSoft in the failure scenario", async () => {
    const service = createService();

    const result = await service.explainFailurePoint({
      businessKey: {
        type: "SalesOrder",
        value: "98421"
      }
    });

    expect(result.failureDetected).toBe(true);
    expect(result.likelyFailurePoint.service).toBe("MuleSoft");
    expect(result.likelyFailurePoint.missingExpectedService).toBe("ERP");
  });

  it("explain_failure_point reports no failure for a successful trace", async () => {
    const service = createService();

    const result = await service.explainFailurePoint({
      businessKey: {
        type: "SalesOrder",
        value: "12345"
      }
    });

    expect(result.failureDetected).toBe(false);
    expect(result.likelyFailurePoint.service).toBe("ERP");
    expect(result.likelyFailurePoint.reason).toContain("No failure evidence detected");
    expect(result.summary).toContain("No failure point detected");
  });

  it("synthesizes fake traces for unknown business keys", async () => {
    const service = createService();

    const traces = await service.findBusinessTraces({
      businessKey: {
        type: "SalesOrder",
        value: "55555"
      }
    });

    expect(traces.matches[0]?.traceId).toBe("trace-salesorder-55555");
    expect(traces.matches[0]?.summary).toContain("fake demo data");

    const timeline = await service.getTraceTimeline({
      traceId: "trace-salesorder-55555"
    });

    expect(timeline.systemsInvolved[0]).toBe("APIM");
    expect(timeline.summary).toContain("Trace trace-salesorder-55555");
  });

  it("resolves business-key-like aliases in get_trace_timeline", async () => {
    const service = createService();

    const timeline = await service.getTraceTimeline({
      traceId: "SalesOrder-55555"
    });

    expect(timeline.traceId).toBe("trace-salesorder-55555");
    expect(timeline.systemsInvolved).toEqual(["APIM", "Solace", "MuleSoft", "ERP"]);
  });

  it("falls back from messy references to the best matching trace", async () => {
    const service = createService();

    const timeline = await service.getTraceTimeline({
      traceId: "abc123-trace-sales-98421"
    });

    expect(timeline.traceId).toBe("trace-salesorder-98421");
    expect(timeline.summary).toContain("fails in MuleSoft");
  });
});
