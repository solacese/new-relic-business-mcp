import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { InvestigationService } from "../services/investigationService.js";
import { explainFailurePointResultSchema } from "../types.js";

const inputSchema = z.object({
  businessKeyType: z.string().min(1).describe("Business key type, for example SalesOrder."),
  businessKeyValue: z.string().min(1).describe("Business key value, for example 12345."),
  lookbackMinutes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional lookback window in minutes.")
});

export function registerExplainFailurePointTool(
  server: McpServer,
  investigationService: InvestigationService
): void {
  server.registerTool(
    "explain_failure_point",
    {
      title: "Explain Failure Point",
      description:
        "Identify the most likely break point or failure point in the flow, with supporting evidence.",
      inputSchema,
      outputSchema: explainFailurePointResultSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ businessKeyType, businessKeyValue, lookbackMinutes }) => {
      const result = await investigationService.explainFailurePoint({
        businessKey: {
          type: businessKeyType,
          value: businessKeyValue
        },
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
