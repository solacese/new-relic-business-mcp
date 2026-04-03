import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { request } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createHttpServer } from "../src/server.js";

async function startTestServer(
  cleanup: Array<() => Promise<void>>,
  env: Record<string, string>
): Promise<number> {
  const server = createHttpServer(loadConfig(env));

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

  return (server.address() as AddressInfo).port;
}

async function httpPost(
  port: number,
  headers: Record<string, string> = {}
): Promise<{ statusCode?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    req.on("error", reject);
    req.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {}
      })
    );
    req.end();
  });
}

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
    const port = await startTestServer(cleanup, {
      BACKEND_MODE: "mock",
      PORT: "0"
    });
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

  it("returns a valid success assessment for explain_failure_point on healthy traces", async () => {
    const port = await startTestServer(cleanup, {
      BACKEND_MODE: "mock",
      PORT: "0"
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    );
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    cleanup.push(async () => {
      await transport.close();
    });

    const result = await client.callTool({
      name: "explain_failure_point",
      arguments: {
        businessKeyType: "SalesOrder",
        businessKeyValue: "12345"
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      traceId: "trace-salesorder-12345",
      failureDetected: false,
      likelyFailurePoint: {
        service: "ERP"
      }
    });
  });

  it("rejects MCP requests without the configured API key", async () => {
    const port = await startTestServer(cleanup, {
      BACKEND_MODE: "mock",
      PORT: "0",
      MCP_API_KEY: "pilot-key"
    });

    const response = await httpPost(port);

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("Unauthorized");
  });

  it("accepts MCP requests with x-api-key when API key auth is enabled", async () => {
    const port = await startTestServer(cleanup, {
      BACKEND_MODE: "mock",
      PORT: "0",
      MCP_API_KEY: "pilot-key"
    });

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      {
        requestInit: {
          headers: {
            "x-api-key": "pilot-key"
          }
        }
      }
    );
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    cleanup.push(async () => {
      await transport.close();
    });

    const result = await client.listTools();

    expect(result.tools).toHaveLength(4);
  });

  it("accepts MCP requests with Authorization bearer tokens when API key auth is enabled", async () => {
    const port = await startTestServer(cleanup, {
      BACKEND_MODE: "mock",
      PORT: "0",
      MCP_API_KEY: "pilot-key"
    });

    const response = await httpPost(port, {
      Authorization: "Bearer pilot-key"
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("\"tools\"");
  });
});
