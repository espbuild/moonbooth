# Moonbooth MCP server (@moonbooth/mcp) — stdio transport.
#
# Location: repository root. Build context: repository root.
# Glama builds this image for its automated safety and quality checks.
# The server starts and answers initialize + tools/list with no secrets
# set: ACT_API_URL / ACT_API_TOKEN are only read when a tool is called,
# so no credentials are needed (or wanted) at build or start time.

# ---- Build stage ------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY . .

# The repo has no root package-lock.json, so `npm ci` is not available;
# `npm install` resolves the workspace tree. The @moonbooth/mcp build
# script first builds its one workspace dependency (@moonbooth/sdk),
# then compiles the server to apps/mcp/dist/main.js.
RUN npm install --no-audit --no-fund \
  && npm run build --workspace @moonbooth/mcp \
  && npm prune --omit=dev

# ---- Runtime stage ----------------------------------------------------
FROM node:22-alpine
WORKDIR /app

COPY --from=build /app ./

# Hosted Moonbooth API by default; override with
#   docker run -e ACT_API_URL=http://localhost:3000 ...
# for a local deployment. ACT_API_TOKEN stays unset unless the caller
# needs the account-level transfer tools.
ENV ACT_API_URL=https://www.moonbooth.ai

USER node

# stdio server: speak JSON-RPC on stdin/stdout.
ENTRYPOINT ["node", "apps/mcp/dist/main.js"]
