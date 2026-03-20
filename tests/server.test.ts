import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createHttpServer } from "../src/server.js";

describe("MCP server", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const close = cleanup.pop();
      if (close) {
        await close();
      }
    }
  });

  it("registers exactly the four intended tools", async () => {
    const server = createHttpServer(
      loadConfig({
        BACKEND_MODE: "mock",
        PORT: "0"
      })
    );

    server.listen(0);
    await once(server, "listening");

    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        })
    );

    const { port } = server.address() as AddressInfo;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    );
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    cleanup.push(async () => {
      await transport.close();
    });

    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "explain_failure_point",
      "fetch_business_logs",
      "find_business_traces",
      "get_trace_timeline"
    ]);
  });
});
