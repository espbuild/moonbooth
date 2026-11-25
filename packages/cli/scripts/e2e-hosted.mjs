// Phase 5 scripted run against a booted ACT web app.
// Boot the web app first (for example: cd apps/web && npx next start
// -p 3105), set ACT_E2E_BASE if it is not http://localhost:3105, pack
// the example package to /tmp/competitor-research.act.json with
// `moonbooth pack examples/competitor-research --out
// /tmp/competitor-research.act.json`, then run: node scripts/e2e-hosted.mjs
// Registers two users, creates API tokens through the session+CSRF
// flow, then drives the real CLI: publish (stops before approval),
// approve (separate command), receive (second user). Also checks that
// a revoked token is refused.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";

const run = promisify(execFile);
const BASE = process.env.ACT_E2E_BASE ?? "http://localhost:3105";
const CLI = ["node", new URL("../dist/main.js", import.meta.url).pathname];

async function cli(args, env) {
  const { stdout, stderr } = await run(CLI[0], [CLI[1], ...args], {
    env: { ...process.env, ...env },
  });
  return stdout + stderr;
}

function cookieJar() {
  const jar = new Map();
  return {
    async fetch(path, init = {}) {
      const headers = { ...(init.headers ?? {}) };
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
      if (cookie) headers.cookie = cookie;
      const res = await fetch(BASE + path, { ...init, headers, redirect: "manual" });
      const setCookies = res.headers.getSetCookie?.() ?? [];
      for (const sc of setCookies) {
        const [pair] = sc.split(";");
        const idx = pair.indexOf("=");
        jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
      return res;
    },
    get: (k) => jar.get(k),
  };
}

async function makeUser(email) {
  const jar = cookieJar();
  const csrfRes = await jar.fetch("/api/v1/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const reg = await jar.fetch("/api/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify({ email, password: "a long password 123", displayName: email }),
  });
  if (!reg.ok) throw new Error(`register ${email} failed: ${reg.status} ${await reg.text()}`);
  // Register sets a fresh CSRF cookie with the session; use that value.
  const sessionCsrf = jar.get("act_csrf");
  const tok = await jar.fetch("/api/v1/tokens", {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": sessionCsrf },
    body: JSON.stringify({ name: "e2e cli" }),
  });
  if (!tok.ok) throw new Error(`token create failed: ${tok.status} ${await tok.text()}`);
  const { token, apiToken } = await tok.json();
  return { jar, csrfToken: sessionCsrf, token, tokenId: apiToken.id };
}

const a = await makeUser("sender@example.com");
const b = await makeUser("recipient@example.com");
console.log("tokens created for sender and recipient");

// Bearer token works without any cookie or CSRF header.
const meRes = await fetch(`${BASE}/api/v1/capabilities`, {
  headers: { authorization: `Bearer ${a.token}` },
});
console.log("bearer GET /capabilities status:", meRes.status);

// Publish as A. Must stop before approval.
const publishOut = await cli(
  ["publish", "/tmp/competitor-research.act.json", "--api", BASE, "--token", a.token, "--recipient", "recipient@example.com"],
);
console.log("--- moonbooth publish ---\n" + publishOut);
const m = /moonbooth approve (\S+) --digest (\S+)/.exec(publishOut);
if (!m) throw new Error("publish output did not include the approve step");
const [, transferId, digest] = m;

// Approve as a separate explicit command.
const approveOut = await cli(
  ["approve", transferId, "--digest", digest, "--api", BASE, "--token", a.token],
);
console.log("--- moonbooth approve ---\n" + approveOut);
const pathMatch = /Invitation path: (\S+)/.exec(approveOut);
const invitePath = pathMatch[1];

// Receive as B and download the package.
const receiveOut = await cli(
  ["receive", BASE + invitePath, "--api", BASE, "--token", b.token, "--out", "/tmp/act-received"],
);
console.log("--- moonbooth receive ---\n" + receiveOut);
console.log("downloaded files:", (await readdir("/tmp/act-received", { recursive: true })).join(", "));

// Revoked token fails.
await a.jar.fetch(`/api/v1/tokens/${a.tokenId}`, {
  method: "DELETE",
  headers: { "x-csrf-token": a.csrfToken },
});
const revokedRes = await fetch(`${BASE}/api/v1/capabilities`, {
  headers: { authorization: `Bearer ${a.token}` },
});
console.log("revoked token GET /capabilities status:", revokedRes.status);
console.log("E2E DONE");
