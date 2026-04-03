FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/sample-data ./sample-data
COPY --from=build /app/README.md ./README.md
COPY --from=build /app/ARCHITECTURE.md ./ARCHITECTURE.md
COPY --from=build /app/OBSERVABILITY_AGENT.md ./OBSERVABILITY_AGENT.md
COPY --from=build /app/AGENT_PROMPT.md ./AGENT_PROMPT.md
COPY --from=build /app/SECURITY.md ./SECURITY.md
COPY --from=build /app/LICENSE ./LICENSE
COPY --from=build /app/mcp-client-config.json ./mcp-client-config.json

EXPOSE 3000

CMD ["node", "dist/server.js"]
