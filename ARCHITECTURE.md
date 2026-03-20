# Architecture

## Intent

`business-investigation-mcp` is a thin semantic layer on top of New Relic. Its job is to answer business investigation questions, not to expose generic observability APIs.

## Components

- `src/server.ts`
  - exposes a stateless Streamable HTTP MCP endpoint on `/mcp`
  - adds a lightweight `/healthz`
- `src/tools/*`
  - the 4 public MCP tools
  - thin wrappers around the shared investigation service
- `src/services/investigationService.ts`
  - owns trace search scoring, timeline reconstruction, log aggregation, and failure inference
- `src/backends/backend.ts`
  - the backend contract
- `src/backends/mockBackend.ts`
  - deterministic sample-data backend
- `src/backends/newRelicBackend.ts`
  - NerdGraph-first live adapter with optional official New Relic MCP discovery validation

## Request flow

1. The client calls a semantic MCP tool such as `find_business_traces`.
2. The tool passes normalized inputs into `InvestigationService`.
3. `InvestigationService` queries the active backend through `InvestigationBackend`.
4. The backend returns raw spans, logs, and related entity hints.
5. `InvestigationService` turns that into stable business-facing JSON.

## Backend contract

The adapter boundary is intentionally small:

- `searchByBusinessKey`
- `getTraceSpans`
- `getTraceLogs`
- `getBusinessLogs`
- `getRelatedEntities`

That keeps the repo understandable in one sitting and makes it easy to replace the mock backend with a customer-specific live adapter.

## Correlation model

The service layer uses a simple, explicit correlation model:

- match business keys in span or log attributes
- match business keys in log message text as a fallback
- group evidence by trace ID
- reconstruct the ordered flow from parent-child spans plus timestamps
- merge logs by trace ID and time window
- infer likely failure from failed spans, error logs, or missing downstream continuation

## Why Streamable HTTP

The repo uses Streamable HTTP rather than stdio so it is easier to host, demo, and share with an enterprise customer. A local AI client can still connect to it with a small HTTP MCP config.
