import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { InvestigationService } from "../services/investigationService.js";
import { findBusinessTracesResultSchema } from "../types.js";

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

export function registerFindBusinessTracesTool(
  server: McpServer,
  investigationService: InvestigationService
): void {
  server.registerTool(
    "find_business_traces",
    {
      title: "Find Business Traces",
      description:
        "Find likely trace IDs, systems involved, and time range for a business key such as SalesOrder=12345.",
      inputSchema,
      outputSchema: findBusinessTracesResultSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ businessKeyType, businessKeyValue, lookbackMinutes }) => {
      const result = await investigationService.findBusinessTraces({
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
