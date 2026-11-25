#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createActMcpServerFromEnv } from "./server.js";

const server = createActMcpServerFromEnv();
await server.connect(new StdioServerTransport());
