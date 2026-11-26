// The telephone game's deterministic drift scorer, implementing the
// scoring definition in the MB-09 scenario (game.scoring) exactly:
//
//   Per seed requirement: 1 when present with every consequential
//   fact intact (numbers, names, negations, ordering); 0.5 when
//   present but a consequential fact is altered; 0 when absent or
//   contradicted. Fidelity at a position is the sum over the seed
//   requirements divided by their count.
//
// "Consequential facts" are extracted mechanically, never judged:
// numbers, email addresses, capitalized names, tag names, negation
// markers, an affirmed/negated pair ("deleted, not archived"), and
// a "X before Y" ordering. A restatement whose facts all match the
// seed's scores 1 even if the wording differs — the definition is
// about facts, not prose. A statement that inverts the seed (negation
// polarity flipped at high content overlap, the affirmed/negated
// pair swapped, the ordering reversed) is a contradiction and scores
// 0; an entry under the right id that barely shares content with the
// seed does not state the requirement and also scores 0.

import type { RequirementEntry } from "./types.js";

export type RequirementVerdict = "intact" | "altered" | "absent" | "contradicted";

export interface RequirementScore {
  id: string;
  score: 0 | 0.5 | 1;
  verdict: RequirementVerdict;
  detail: string;
}

export interface RestatementScore {
  scores: RequirementScore[];
  /** Sum of per-requirement scores divided by the seed count. */
  fidelity: number;
  omissions: number;
  distortions: number;
  contradictions: number;
}

export interface PositionScore extends RestatementScore {
  /** Chain position, 1-based (the seat that produced the restatement). */
  position: number;
}

export interface ChainScore {
  positions: PositionScore[];
  endFidelity: number;
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "it", "its", "of", "to", "in", "on",
  "per", "with", "by", "for", "that", "this", "has", "have", "be", "or",
  "and", "at", "from", "each", "as", "when", "than", "then", "so",
  "into", "after", "before", "unless", "if",
]);

const NEGATION_PATTERN = /\b(never|not|no|cannot|can't)\b|\w+n't\b/g;

export function normalizeStatement(statement: string): string {
  return statement
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");
}

interface Facts {
  numbers: string[];
  emails: string[];
  names: string[];
  tags: string[];
  negations: number;
  pair: { affirmed: string; negated: string } | null;
  ordering: { left: string[]; right: string[] } | null;
}

function contentTokens(normalized: string): string[] {
  return (normalized.match(/[a-z0-9@.']+/g) ?? []).filter(
    (t) => !STOPWORDS.has(t) && !/^(never|not|no|cannot)$/.test(t),
  );
}

function extractFacts(statement: string): Facts {
  const normalized = normalizeStatement(statement);
  const numbers = [...normalized.matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
  const emails = [...normalized.matchAll(/[\w.]+@[\w.]+/g)].map((m) => m[0]);
  // Capitalized phrases in the original statement, excluding the
  // sentence-initial word ("Sunday Sort" in R3).
  const words = statement.split(/\s+/);
  const names: string[] = [];
  let current: string[] = [];
  words.forEach((word, i) => {
    const clean = word.replace(/[^A-Za-z'-]/g, "");
    if (i > 0 && /^[A-Z]/.test(clean)) {
      current.push(clean);
    } else {
      if (current.length > 0) names.push(current.join(" "));
      current = [];
    }
  });
  if (current.length > 0) names.push(current.join(" "));
  const tags = [...normalized.matchAll(/\btag ([a-z0-9_-]+)/g)].map((m) => m[1]);
  const negations = (normalized.match(NEGATION_PATTERN) ?? []).length;
  const pairMatch = normalized.match(/(\w+), not (\w+)/);
  const pair = pairMatch ? { affirmed: pairMatch[1], negated: pairMatch[2] } : null;
  let ordering: Facts["ordering"] = null;
  const beforeIdx = normalized.split(" ").indexOf("before");
  if (beforeIdx >= 0) {
    const tokens = normalized.split(" ");
    ordering = {
      left: contentTokens(tokens.slice(Math.max(0, beforeIdx - 3), beforeIdx).join(" ")),
      right: contentTokens(tokens.slice(beforeIdx + 1, beforeIdx + 4).join(" ")),
    };
  }
  return { numbers, emails, names, tags, negations, pair, ordering };
}

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = (x: string[]) => [...x].sort();
  return sorted(a).every((v, i) => v === sorted(b)[i]);
}

function contentOverlap(seedNormalized: string, restatedNormalized: string): number {
  const seedTokens = new Set(contentTokens(seedNormalized));
  if (seedTokens.size === 0) return 1;
  const restatedTokens = new Set(contentTokens(restatedNormalized));
  let shared = 0;
  for (const t of seedTokens) if (restatedTokens.has(t)) shared++;
  return shared / seedTokens.size;
}

function orderingReversed(seed: Facts["ordering"], restated: Facts["ordering"]): boolean {
  if (!seed || !restated) return false;
  // The ordering's key tokens are the ones that appear on only one
  // side of the seed's "before" (for R7: "untagged" on the left,
  // "tagged" on the right; shared context like "bookmarks" sits on
  // both sides or stays put). The ordering is reversed when the left
  // keys have moved to the right and the right keys to the left, and
  // the keys have not simply stayed where they were.
  const leftKey = seed.left.filter((t) => !seed.right.includes(t));
  const rightKey = seed.right.filter((t) => !seed.left.includes(t));
  if (leftKey.length === 0 || rightKey.length === 0) return false;
  const leftMovedRight = leftKey.some((t) => restated.right.includes(t));
  const rightMovedLeft = rightKey.some((t) => restated.left.includes(t));
  const leftStayed = leftKey.every((t) => restated.left.includes(t));
  const rightStayed = rightKey.every((t) => restated.right.includes(t));
  return leftMovedRight && rightMovedLeft && !leftStayed && !rightStayed;
}

/** Score one seed requirement against its entry in a restatement. */
export function scoreRequirement(
  seed: RequirementEntry,
  restated: RequirementEntry | undefined,
): RequirementScore {
  if (!restated) {
    return {
      id: seed.id,
      score: 0,
      verdict: "absent",
      detail: "requirement absent from the restatement",
    };
  }
  const seedNorm = normalizeStatement(seed.statement);
  const restNorm = normalizeStatement(restated.statement);
  if (seedNorm === restNorm) {
    return { id: seed.id, score: 1, verdict: "intact", detail: "statement identical to the seed" };
  }
  const a = extractFacts(seed.statement);
  const b = extractFacts(restated.statement);
  const overlap = contentOverlap(seedNorm, restNorm);
  if (overlap < 0.3) {
    return {
      id: seed.id,
      score: 0,
      verdict: "contradicted",
      detail: `entry under this id does not state the seed requirement (content overlap ${overlap.toFixed(2)})`,
    };
  }
  // Contradictions: the restatement asserts the opposite of the seed.
  if (a.pair && b.pair && b.pair.affirmed === a.pair.negated && b.pair.negated === a.pair.affirmed) {
    return {
      id: seed.id,
      score: 0,
      verdict: "contradicted",
      detail: `affirmed/negated pair inverted ("${a.pair.affirmed}, not ${a.pair.negated}" became "${b.pair.affirmed}, not ${b.pair.negated}")`,
    };
  }
  if (orderingReversed(a.ordering, b.ordering)) {
    return { id: seed.id, score: 0, verdict: "contradicted", detail: "ordering reversed" };
  }
  if (a.negations !== b.negations && overlap >= 0.5) {
    return {
      id: seed.id,
      score: 0,
      verdict: "contradicted",
      detail: `negation count differs (seed ${a.negations}, restated ${b.negations}) at content overlap ${overlap.toFixed(2)}`,
    };
  }
  // Alterations: present, about the same requirement, but a
  // consequential fact changed.
  const diffs: string[] = [];
  if (!sameMultiset(a.numbers, b.numbers)) {
    diffs.push(`numbers [${a.numbers.join(", ")}] became [${b.numbers.join(", ")}]`);
  }
  if (!sameMultiset(a.emails, b.emails)) diffs.push("email address changed");
  if (!sameMultiset(a.names, b.names)) {
    diffs.push(`names [${a.names.join("; ")}] became [${b.names.join("; ")}]`);
  }
  if (!sameMultiset(a.tags, b.tags)) {
    diffs.push(`tag names [${a.tags.join(", ")}] became [${b.tags.join(", ")}]`);
  }
  if (a.negations !== b.negations) {
    diffs.push(`negation count differs (seed ${a.negations}, restated ${b.negations})`);
  }
  if ((a.ordering === null) !== (b.ordering === null)) {
    diffs.push("ordering clause added or dropped");
  }
  if (diffs.length > 0) {
    return { id: seed.id, score: 0.5, verdict: "altered", detail: diffs.join("; ") };
  }
  return {
    id: seed.id,
    score: 1,
    verdict: "intact",
    detail: "every consequential fact intact; wording differs",
  };
}

/** Score one seat's restatement against the seed. */
export function scoreRestatement(
  seed: RequirementEntry[],
  restatement: RequirementEntry[],
): RestatementScore {
  const byId = new Map(restatement.map((e) => [e.id, e]));
  const scores = seed.map((req) => scoreRequirement(req, byId.get(req.id)));
  const sum = scores.reduce((acc, s) => acc + s.score, 0);
  return {
    scores,
    fidelity: Math.round((sum / seed.length) * 10000) / 10000,
    omissions: scores.filter((s) => s.verdict === "absent").length,
    distortions: scores.filter((s) => s.verdict === "altered").length,
    contradictions: scores.filter((s) => s.verdict === "contradicted").length,
  };
}

/** Score every seat's restatement: the fidelity curve. */
export function scoreChain(
  seed: RequirementEntry[],
  restatements: RequirementEntry[][],
): ChainScore {
  const positions = restatements.map((restatement, i) => ({
    position: i + 1,
    ...scoreRestatement(seed, restatement),
  }));
  return {
    positions,
    endFidelity: positions.length > 0 ? positions[positions.length - 1].fidelity : 0,
  };
}

/**
 * Score seat 3's answer to the stakeholder question ("Does the digest
 * ever list tagged bookmarks first?") against R7 as seeded: correct
 * iff the answer asserts that untagged bookmarks come before tagged
 * ones. The answer is scored against the seed, not against what the
 * seat received — the scenario's probe check separates a fact the
 * chain lost from a fact the seat misread by comparing the two.
 */
export function scoreProbeAnswer(answer: string | null): {
  correct: boolean;
  detail: string;
} {
  if (answer === null || answer.trim() === "") {
    return { correct: false, detail: "no probe answer recorded" };
  }
  const a = normalizeStatement(answer);
  if (/tagged bookmarks before untagged/.test(a)) {
    return { correct: false, detail: "answer asserts tagged bookmarks come first" };
  }
  const untaggedIdx = a.indexOf("untagged");
  const taggedIdx = a.indexOf("tagged");
  if (untaggedIdx >= 0 && taggedIdx > untaggedIdx && a.includes("before")) {
    return { correct: true, detail: "answer states untagged bookmarks come before tagged ones" };
  }
  return {
    correct: false,
    detail: "answer does not state that untagged bookmarks come first",
  };
}
