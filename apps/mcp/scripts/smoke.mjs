// Spawn the built MCP server over stdio and run the MCP handshake:
// initialize, tools/list, and one act_get_transfer call against a stub
// API server. Prints the raw JSON-RPC responses.
//
// Usage: npm run build (in apps/mcp), then node scripts/smoke.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const api = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/v1/transfers/t1") {
    res.end(JSON.stringify({ transfer: { id: "t1", state: "DRAFT", digest: "abc" } }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: "not_found", message: "Not found." } }));
  }
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const apiUrl = `http://127.0.0.1:${api.address().port}`;

const main = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "main.js");
const child = spawn("node", [main], {
  env: { ...process.env, ACT_API_URL: apiUrl, ACT_API_TOKEN: "act_smoke_token" },
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolvePromise) => {
    pending.set(id, resolvePromise);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const init = await request("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "act-smoke", version: "0.0.1" },
});
console.log("initialize:", JSON.stringify(init.result?.serverInfo ?? init));
notify("notifications/initialized", {});
const tools = await request("tools/list", {});
console.log("tools/list:", JSON.stringify(tools.result?.tools?.map((t) => t.name) ?? tools));
const call = await request("tools/call", { name: "act_get_transfer", arguments: { transferId: "t1" } });
console.log("tools/call act_get_transfer:", JSON.stringify(call.result ?? call));

child.kill();
api.close();
