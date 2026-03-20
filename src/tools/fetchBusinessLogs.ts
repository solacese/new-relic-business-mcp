import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { InvestigationService } from "../services/investigationService.js";
import { fetchBusinessLogsResultSchema } from "../types.js";

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

export function registerFetchBusinessLogsTool(
  server: McpServer,
  investigationService: InvestigationService
): void {
  server.registerTool(
    "fetch_business_logs",
    {
      title: "Fetch Business Logs",
      description:
        "Return logs linked directly or indirectly to the business transaction identified by the business key.",
      inputSchema,
      outputSchema: fetchBusinessLogsResultSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ businessKeyType, businessKeyValue, lookbackMinutes }) => {
      const result = await investigationService.fetchBusinessLogs({
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
