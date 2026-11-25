import { describe, it, expect } from "vitest";
import { scanForSecrets, hasBlockingFinding } from "../src/index.js";

// All secrets in this file are synthetic fakes built for these tests.
const FAKE_AWS = "AKIA" + "IOSFODNN7" + "EXAMPLE";
const FAKE_GITHUB = "ghp_" + "a1B2c3D4".repeat(5);
const FAKE_OPENAI = "sk-proj-" + "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8";
const FAKE_STRIPE = "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc";

describe("scanForSecrets", () => {
  it("detects an AWS access key id", () => {
    const findings = scanForSecrets([{ path: "SKILL.md", content: `key is ${FAKE_AWS} here` }]);
    expect(findings.some((f) => f.kind === "aws_access_key" && f.severity === "critical")).toBe(true);
    expect(findings[0].file).toBe("SKILL.md");
    expect(findings[0].line).toBe(1);
  });

  it("detects GitHub and OpenAI style tokens with line numbers", () => {
    const content = ["line one", `token: ${FAKE_GITHUB}`, `other: ${FAKE_OPENAI}`].join("\n");
    const findings = scanForSecrets([{ path: "a.md", content }]);
    expect(findings.find((f) => f.kind === "github_token")?.line).toBe(2);
    expect(findings.find((f) => f.kind === "openai_api_key")?.line).toBe(3);
  });

  it("detects private key headers and generic provider tokens", () => {
    const findings = scanForSecrets([
      { path: "k.txt", content: "-----BEGIN RSA PRIVATE KEY-----\nabc" },
      { path: "s.txt", content: `stripe ${FAKE_STRIPE}` },
    ]);
    expect(findings.some((f) => f.kind === "private_key")).toBe(true);
    expect(findings.some((f) => f.kind === "generic_api_token")).toBe(true);
  });

  it("detects credential assignments but skips placeholders and env references", () => {
    const bad = scanForSecrets([{ path: "c.md", content: 'api_key = "Zx9Qw8Er7Ty6Ui5Op4"' }]);
    expect(bad.some((f) => f.kind === "credential_assignment")).toBe(true);
    const ok = scanForSecrets([
      {
        path: "c.md",
        content: [
          'password = "changeme"',
          "api_key = process.env.MY_KEY",
          'secret: "example-value-here"',
          "token = ${TOKEN}",
        ].join("\n"),
      },
    ]);
    expect(ok.filter((f) => f.kind === "credential_assignment")).toHaveLength(0);
  });

  it("flags long high-entropy strings above the documented threshold", () => {
    const token = "kX7fQ2wZ9pL4mN8vR3tY6bH1sD5gJ0aKcFeGdBhNjMkPlOqRsTuVwXyZ";
    const findings = scanForSecrets([{ path: "e.md", content: `blob ${token} end` }]);
    expect(findings.some((f) => f.kind === "high_entropy_string")).toBe(true);
  });

  it("returns no findings for clean content, prose, and hex digests", () => {
    const digest = "a337beddffef4bc841ec64c193069cb839b41b7a6a7d2972051b6960cb7646e9";
    const findings = scanForSecrets([
      { path: "SKILL.md", content: "# Notes\n\nWrite a short report. Digest: " + digest },
      { path: "r.md", content: "The quick brown fox jumps over the lazy dog, repeatedly and calmly." },
    ]);
    expect(findings).toEqual([]);
  });

  it("never returns the secret value itself", () => {
    const findings = scanForSecrets([
      { path: "x.md", content: `${FAKE_AWS}\n${FAKE_GITHUB}\n${FAKE_OPENAI}\npassword = "Zx9Qw8Er7Ty6Ui5Op4"` },
    ]);
    const serialized = JSON.stringify(findings);
    for (const secret of [FAKE_AWS, FAKE_GITHUB, FAKE_OPENAI, "Zx9Qw8Er7Ty6Ui5Op4"]) {
      expect(serialized).not.toContain(secret);
    }
    for (const f of findings) expect(f.redacted.length).toBeLessThanOrEqual(5);
  });

  it("accepts Map and record inputs and Uint8Array content", () => {
    const fromMap = scanForSecrets(new Map([["m.md", `k ${FAKE_AWS}`]]));
    const fromRecord = scanForSecrets({ "r.md": new TextEncoder().encode(`k ${FAKE_AWS}`) });
    expect(fromMap).toHaveLength(1);
    expect(fromRecord).toHaveLength(1);
  });

  it("hasBlockingFinding is true for critical and high, false for none", () => {
    expect(hasBlockingFinding(scanForSecrets([{ path: "a", content: FAKE_AWS }]))).toBe(true);
    expect(hasBlockingFinding([])).toBe(false);
  });
});
