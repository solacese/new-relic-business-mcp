import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { loadConfig, type AppConfig } from "./config.js";
import type { InvestigationBackend } from "./backends/backend.js";
import { MockBackend } from "./backends/mockBackend.js";
import { NewRelicBackend } from "./backends/newRelicBackend.js";
import { InvestigationService } from "./services/investigationService.js";
import { registerExplainFailurePointTool } from "./tools/explainFailurePoint.js";
import { registerFetchBusinessLogsTool } from "./tools/fetchBusinessLogs.js";
import { registerFindBusinessTracesTool } from "./tools/findBusinessTraces.js";
import { registerGetTraceTimelineTool } from "./tools/getTraceTimeline.js";

type RuntimeDependencies = {
  config: AppConfig;
  backend: InvestigationBackend;
  investigationService: InvestigationService;
};

function createBackend(config: AppConfig): InvestigationBackend {
  return config.backendMode === "newrelic"
    ? new NewRelicBackend(config.newRelic)
    : MockBackend.fromSampleData();
}

export function createRuntimeDependencies(config = loadConfig()): RuntimeDependencies {
  const backend = createBackend(config);
  const investigationService = new InvestigationService(backend, config.defaultLookbackMinutes);

  return {
    config,
    backend,
    investigationService
  };
}

export function createMcpApplication(
  deps: Pick<RuntimeDependencies, "config" | "investigationService">
): McpServer {
  const server = new McpServer(
    {
      name: deps.config.serverName,
      version: deps.config.serverVersion
    },
    {
      capabilities: {
        logging: {}
      },
      instructions:
        "Use the business investigation tools to answer order-flow questions. Do not request raw New Relic primitives."
    }
  );

  registerFindBusinessTracesTool(server, deps.investigationService);
  registerGetTraceTimelineTool(server, deps.investigationService);
  registerFetchBusinessLogsTool(server, deps.investigationService);
  registerExplainFailurePointTool(server, deps.investigationService);

  return server;
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function getHeaderValue(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) {
    return header[0];
  }

  return header;
}

function extractApiKey(req: IncomingMessage): string | undefined {
  const directHeader = getHeaderValue(req.headers["x-api-key"]);

  if (directHeader && directHeader.trim().length > 0) {
    return directHeader.trim();
  }

  const authorization = getHeaderValue(req.headers.authorization);

  if (!authorization) {
    return undefined;
  }

  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1]?.trim() || undefined;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorized(req: IncomingMessage, config: AppConfig): boolean {
  const expectedApiKey = config.auth.apiKey;

  if (!expectedApiKey) {
    return true;
  }

  const receivedApiKey = extractApiKey(req);
  return receivedApiKey ? safeEqual(receivedApiKey, expectedApiKey) : false;
}

function sendUnauthorized(res: ServerResponse): void {
  res.setHeader("WWW-Authenticate", 'Bearer realm="business-investigation-mcp"');
  sendJson(res, 401, {
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message: "Unauthorized. Provide x-api-key or Authorization: Bearer <token>."
    },
    id: null
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
      continue;
    }

    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    }
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RuntimeDependencies
): Promise<void> {
  const body = req.method === "POST" ? await readJsonBody(req) : undefined;
  const app = createMcpApplication(deps);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  try {
    await app.connect(transport);
    await transport.handleRequest(req, res, body);
  } finally {
    res.on("close", () => {
      void transport.close();
      void app.close();
    });
  }
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RuntimeDependencies
): Promise<void> {
  if (!req.url) {
    sendJson(res, 400, { error: "Missing request URL." });
    return;
  }

  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/healthz") {
    sendJson(res, 200, {
      status: "ok",
      backendMode: deps.config.backendMode,
      transport: "streamable-http"
    });
    return;
  }

  if (url.pathname !== "/mcp") {
    sendJson(res, 404, { error: "Not found." });
    return;
  }

  if (!isAuthorized(req, deps.config)) {
    sendUnauthorized(res);
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed."
      },
      id: null
    });
    return;
  }

  await handleMcpRequest(req, res, deps);
}

export function createHttpServer(config = loadConfig()): Server {
  const deps = createRuntimeDependencies(config);

  return createServer((req, res) => {
    void routeRequest(req, res, deps).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unexpected server error.";
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message
          },
          id: null
        });
      } else {
        res.end();
      }
    });
  });
}

export async function startServer(config = loadConfig()): Promise<Server> {
  const server = createHttpServer(config);

  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, () => resolve());
    server.once("error", reject);
  });

  return server;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const server = await startServer(config);

  process.on("SIGINT", () => {
    server.close(() => {
      process.exit(0);
    });
  });

  process.on("SIGTERM", () => {
    server.close(() => {
      process.exit(0);
    });
  });

  process.stdout.write(
    `business-investigation-mcp listening on http://localhost:${config.port}/mcp\n`
  );
}

const isEntryPoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntryPoint) {
  void main();
}
