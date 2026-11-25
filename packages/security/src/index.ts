/**
 * @moonbooth/security - secret scanning for capability packages.
 *
 * scanForSecrets looks for common credential shapes in package files:
 * cloud and provider keys, token prefixes, private key headers,
 * password/secret assignments, and long high-entropy strings.
 *
 * Entropy rule (documented threshold): a run of 32 or more characters
 * from the base64/base64url/hex-adjacent alphabet is flagged when its
 * Shannon entropy is at least ENTROPY_THRESHOLD (4.5 bits per
 * character) and it mixes letters with digits. Plain hex digests
 * (entropy at most 4.0) and ordinary prose stay below the threshold.
 *
 * Findings never carry the matched value. The only excerpt is a
 * redacted snippet of at most REDACTED_PREFIX + 3 characters: the
 * first two characters of the match followed by "***".
 */

export const PACKAGE_NAME = "@moonbooth/security";

export type SecretSeverity = "critical" | "high" | "medium";

export type SecretKind =
  | "aws_access_key"
  | "github_token"
  | "openai_api_key"
  | "generic_api_token"
  | "private_key"
  | "credential_assignment"
  | "high_entropy_string";

export interface SecretFinding {
  file: string;
  line: number;
  kind: SecretKind;
  severity: SecretSeverity;
  /** Redacted excerpt: first two characters of the match plus "***". */
  redacted: string;
}

export interface ScannableFile {
  path: string;
  content: string | Uint8Array;
}

export const ENTROPY_THRESHOLD = 4.5;
export const ENTROPY_MIN_LENGTH = 32;

function redact(match: string): string {
  return `${match.slice(0, 2)}***`;
}

interface Pattern {
  kind: SecretKind;
  severity: SecretSeverity;
  regex: RegExp;
}

const PATTERNS: Pattern[] = [
  {
    kind: "aws_access_key",
    severity: "critical",
    regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    kind: "github_token",
    severity: "critical",
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    kind: "openai_api_key",
    severity: "critical",
    regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    kind: "generic_api_token",
    severity: "high",
    // Common provider prefixes: Slack, Stripe, npm, PyPI, SendGrid, JWT.
    regex:
      /\b(?:xox[baprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{16,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  },
  {
    kind: "private_key",
    severity: "critical",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
];

// name = value / name: "value" assignments for credential-like names.
const ASSIGNMENT =
  /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?([^\s"'`,;]{8,})/gi;

const PLACEHOLDER =
  /^(?:example|sample|demo|test|fake|dummy|placeholder|changeme|change-me|your[-_]|xxx+|\*+|<|\$\{|process\.env|env\.|os\.environ|redacted|null|none|true|false)/i;

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{32,}/g;

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * Scan files for likely credentials. Accepts an array of
 * { path, content } entries, a Map, or a plain record of path to
 * content. Returns findings sorted by file, then line. The matched
 * secret value is never included in a finding.
 */
export function scanForSecrets(
  files:
    | ScannableFile[]
    | Map<string, string | Uint8Array>
    | Record<string, string | Uint8Array>,
): SecretFinding[] {
  const entries: ScannableFile[] =
    files instanceof Map
      ? [...files.entries()].map(([path, content]) => ({ path, content }))
      : Array.isArray(files)
        ? files
        : Object.entries(files).map(([path, content]) => ({ path, content }));

  const findings: SecretFinding[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });

  for (const file of entries) {
    const text =
      typeof file.content === "string" ? file.content : decoder.decode(file.content);
    const seen = new Set<string>();
    const add = (kind: SecretKind, severity: SecretSeverity, index: number, match: string) => {
      const line = lineOf(text, index);
      const key = `${line}:${kind}:${index}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({ file: file.path, line, kind, severity, redacted: redact(match) });
    };

    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.regex.exec(text)) !== null) {
        add(pattern.kind, pattern.severity, m.index, m[0]);
      }
    }

    ASSIGNMENT.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = ASSIGNMENT.exec(text)) !== null) {
      const value = a[2];
      if (PLACEHOLDER.test(value)) continue;
      // A value that is itself a known token shape is already reported
      // by the specific patterns above; still record the assignment.
      add("credential_assignment", "high", a.index, value);
    }

    ENTROPY_CANDIDATE.lastIndex = 0;
    let e: RegExpExecArray | null;
    while ((e = ENTROPY_CANDIDATE.exec(text)) !== null) {
      const token = e[0];
      if (!/[A-Za-z]/.test(token) || !/[0-9]/.test(token)) continue;
      // Skip spans already matched by a specific pattern on this line.
      if (shannonEntropy(token) >= ENTROPY_THRESHOLD) {
        const line = lineOf(text, e.index);
        const already = findings.some(
          (f) => f.file === file.path && f.line === line && f.kind !== "credential_assignment",
        );
        if (!already) add("high_entropy_string", "medium", e.index, token);
      }
    }
  }

  findings.sort((x, y) =>
    x.file === y.file ? x.line - y.line || x.kind.localeCompare(y.kind) : x.file.localeCompare(y.file),
  );
  return findings;
}

/** True when findings include a likely credential that must block approval. */
export function hasBlockingFinding(findings: SecretFinding[]): boolean {
  return findings.some((f) => f.severity === "critical" || f.severity === "high");
}
