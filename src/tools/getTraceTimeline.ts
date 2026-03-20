import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { InvestigationService } from "../services/investigationService.js";
import { getTraceTimelineResultSchema } from "../types.js";

const inputSchema = z.object({
  traceId: z.string().min(1).describe("Trace identifier returned by find_business_traces."),
  lookbackMinutes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional lookback window in minutes.")
});

export function registerGetTraceTimelineTool(
  server: McpServer,
  investigationService: InvestigationService
): void {
  server.registerTool(
    "get_trace_timeline",
    {
      title: "Get Trace Timeline",
      description:
        "Reconstruct an ordered end-to-end timeline for a trace using spans and related logs.",
      inputSchema,
      outputSchema: getTraceTimelineResultSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ traceId, lookbackMinutes }) => {
      const result = await investigationService.getTraceTimeline({
        traceId,
        lookbackMinutes
      });

      return {
        content: [
          {
            type: "text",
            text: result.summary
          }
        ],
        structuredContent: result
      };
    }
  );
}
