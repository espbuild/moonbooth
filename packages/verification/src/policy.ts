import { ALLOWED_EXTENSIONS, type ActManifest, type PackageFile } from "@moonbooth/protocol";
import { scanForSecrets } from "@moonbooth/security";
import type { PolicyCeiling, PolicyFinding, SecurityResult } from "./types.js";

/**
 * Security policy verification.
 *
 * Runs the @moonbooth/security secret scan over every package file, then a
 * fixed set of policy rules over the manifest and the package text:
 * disallowed file types, tools on the denylist, permission requests
 * past the policy ceiling, instruction text aimed at the agent
 * (override attempts, requests to reveal context or secrets,
 * persistence requests, external references, writes outside an
 * authorized directory).
 *
 * Findings are pattern matches. A finding says a rule matched at a
 * location; it does not prove intent. Passing says no rule matched a
 * blocking pattern; it does not prove a package is safe.
 */

export const SECURITY_LIMITATION =
  "These checks ran a fixed set of pattern and policy rules over the package text. Passing them does not prove a package is safe. Text that no rule matches can still be harmful, and no check here runs the capability or watches what an agent does with it after adoption.";

/** Tools a package must not require under the default policy. */
export const DENIED_TOOLS = [
  "shell",
  "bash",
  "sh",
  "zsh",
  "terminal",
  "command-execution",
  "code-execution",
  "exec",
  "credential-access",
  "credentials",
  "keychain",
  "password-store",
  "secret-store",
] as const;

interface TextPattern {
  kind: string;
  severity: "blocking" | "warning";
  regex: RegExp;
  message: string;
}

const TEXT_PATTERNS: TextPattern[] = [
  {
    kind: "instruction_override",
    severity: "blocking",
    regex:
      /\b(ignore|disregard|forget|override)\b[^.\n]{0,60}\b(previous|prior|above|system|developer)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?)\b/i,
    message: "Instruction text tells the agent to ignore or override earlier or system instructions.",
  },
  {
    kind: "instruction_override",
    severity: "blocking",
    regex: /\bignore (all )?(instructions|rules|directions)\b/i,
    message: "Instruction text tells the agent to ignore instructions.",
  },
  {
    kind: "reveal_private_context",
    severity: "blocking",
    regex:
      /\b(reveal|print|show|expose|leak|dump|repeat)\b[^.\n]{0,60}\b(system prompt|developer prompt|hidden instructions?|private context|confidential context|system instructions?)\b/i,
    message: "Instruction text asks the agent to reveal system prompts or private context.",
  },
  {
    kind: "reveal_secrets",
    severity: "blocking",
    regex:
      /\b(reveal|print|show|expose|leak|send|post|upload)\b[^.\n]{0,60}\b(api keys?|secrets?|credentials?|passwords?|tokens?|private keys?)\b/i,
    message: "Instruction text asks the agent to reveal or send secrets or credentials.",
  },
  {
    kind: "persistent_automation",
    severity: "warning",
    regex:
      /\b(create|set up|schedule|install|register)\b[^.\n]{0,50}\b(cron( job)?|scheduled (job|task)|recurring (job|task|automation)|background (job|task|daemon)|automation)\b/i,
    message: "Instruction text asks the agent to create a scheduled job or other persistent automation.",
  },
  {
    kind: "persistent_automation",
    severity: "warning",
    regex: /\b(persist|keep running|run forever|run every (day|hour|night|week))\b/i,
    message: "Instruction text asks the agent to persist or keep running beyond the task.",
  },
  {
    kind: "write_outside_authorized_directory",
    severity: "warning",
    regex:
      /\b(write|save|copy|create|modify|delete)\b[^.\n]{0,60}(\/etc\/|\/usr\/|~\/\.ssh|\/root\/|outside (the|an|any) (workspace|project|authorized|working) director)/i,
    message: "Instruction text asks the agent to write outside an authorized directory or into a system path.",
  },
  {
    kind: "denied_tool_request",
    severity: "warning",
    regex:
      /\b(use|run|invoke|call|open)\b[^.\n]{0,40}\b(shell|bash|terminal|command line|keychain|credential store)\b/i,
    message: "Instruction text asks the agent to use a tool on the denylist (shell or credential access).",
  },
];

const URL_PATTERN = /https?:\/\/[^\s)"'<>]+/gi;

function isInternalHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h === "169.254.169.254" ||
    h.startsWith("127.") ||
    h.startsWith("10.") ||
    h.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h.endsWith(".internal") ||
    h.endsWith(".local")
  );
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot).toLowerCase();
}

const ARCHIVE_EXTENSIONS = [".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar"];

export function verifySecurity(input: {
  manifest: ActManifest | null;
  files: PackageFile[];
  policyCeiling?: PolicyCeiling;
}): SecurityResult {
  const findings: PolicyFinding[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const texts = input.files.map((f) => ({
    path: f.path,
    text: decoder.decode(f.content),
    content: f.content,
  }));

  // Secret scan (Phase 3 engine, reused).
  for (const finding of scanForSecrets(
    input.files.map((f) => ({ path: f.path, content: f.content })),
  )) {
    findings.push({
      kind: `secret_${finding.kind}`,
      severity: finding.severity === "medium" ? "warning" : "blocking",
      file: finding.file,
      line: finding.line,
      message: `Secret scan found a likely ${finding.kind.replace(/_/g, " ")} (severity ${finding.severity}); value starts ${finding.redacted}.`,
    });
  }

  // File type policy.
  for (const file of texts) {
    const ext = extensionOf(file.path);
    if (ARCHIVE_EXTENSIONS.includes(ext)) {
      findings.push({
        kind: "disallowed_file_type",
        severity: "blocking",
        file: file.path,
        line: 1,
        message: `File "${file.path}" is a nested archive, which the package rules bar.`,
      });
    } else if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
      findings.push({
        kind: "disallowed_file_type",
        severity: "blocking",
        file: file.path,
        line: 1,
        message: `File "${file.path}" has type "${ext || "(none)"}", which is not on the allowlist.`,
      });
    }
    if (file.content.length >= 2 && file.content[0] === 0x23 && file.content[1] === 0x21) {
      findings.push({
        kind: "script_file",
        severity: "blocking",
        file: file.path,
        line: 1,
        message: `File "${file.path}" starts with a shebang and counts as a script.`,
      });
    }
  }

  // Instruction text patterns and external references.
  for (const file of texts) {
    for (const pattern of TEXT_PATTERNS) {
      const re = new RegExp(pattern.regex.source, pattern.regex.flags.includes("i") ? "gi" : "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(file.text)) !== null) {
        findings.push({
          kind: pattern.kind,
          severity: pattern.severity,
          file: file.path,
          line: lineOf(file.text, m.index),
          message: pattern.message,
        });
      }
    }
    URL_PATTERN.lastIndex = 0;
    let u: RegExpExecArray | null;
    while ((u = URL_PATTERN.exec(file.text)) !== null) {
      let host = "";
      try {
        host = new URL(u[0]).hostname;
      } catch {
        host = "";
      }
      const internal = host !== "" && isInternalHost(host);
      findings.push({
        kind: "external_reference",
        severity: internal ? "blocking" : "warning",
        file: file.path,
        line: lineOf(file.text, u.index),
        message: internal
          ? `Instruction text points at an internal or local address (${host}), a server-side request forgery shape.`
          : `Instruction text points at an external URL (${host || u[0]}). The recipient environment decides whether any fetch is allowed.`,
      });
    }
  }

  // Manifest policy: denied tools and permission ceiling.
  if (input.manifest) {
    for (const tool of input.manifest.requirements.tools) {
      if ((DENIED_TOOLS as readonly string[]).includes(tool.toLowerCase())) {
        findings.push({
          kind: "denied_tool",
          severity: "blocking",
          file: "act.json",
          line: 1,
          message: `The manifest requires the tool "${tool}", which is on the denylist (shell execution or credential access).`,
        });
      }
    }
    const flagExternal = input.policyCeiling?.flag_external_side_effects ?? true;
    if (flagExternal && input.manifest.requested_permissions.external_side_effects) {
      findings.push({
        kind: "permission_policy_flag",
        severity: "warning",
        file: "act.json",
        line: 1,
        message:
          "The package requests external_side_effects permission, which is past the policy ceiling for this check. The request grants nothing by itself; the recipient decides.",
      });
    }
  }

  findings.sort((a, b) =>
    a.file === b.file ? a.line - b.line || a.kind.localeCompare(b.kind) : a.file.localeCompare(b.file),
  );
  const blocked = findings.some((f) => f.severity === "blocking");
  return {
    label: blocked ? "FAILED" : "POLICY_CHECKS_PASSED",
    findings,
    limitation: SECURITY_LIMITATION,
  };
}
