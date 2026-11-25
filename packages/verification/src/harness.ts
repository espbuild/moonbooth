import type {
  BehavioralResult,
  CaseRun,
  CaseScores,
  EvidenceItem,
  FixtureFact,
  TestCase,
  TestSuiteData,
} from "./types.js";

/**
 * Behavioral harness. Instructions-only, deterministic, offline.
 *
 * For each test case the harness builds two text outputs from the
 * case's fixture documents:
 *
 * - baseline: a fixed generic procedure that does not use the skill.
 *   It writes one unstructured paragraph per company, states claims
 *   as findings, adds a market-leader sentence no fixture supports,
 *   guesses at missing data, and never names missing information.
 * - with-capability: a procedure that reads the skill text and applies
 *   only the steps the skill states. Step detection is pattern based:
 *   a step the skill text does not state is not applied, and the
 *   output scores worse on the criteria that step feeds.
 *
 * Scoring is a set of plain functions over the generated text and the
 * fixtures. No score is stored anywhere; every number comes from
 * running these functions on the generated output.
 */

export interface SkillSteps {
  scope: boolean;
  claimsVsEvidence: boolean;
  featureTable: boolean;
  segmentTable: boolean;
  positioning: boolean;
  missingInfo: boolean;
  unknownCells: boolean;
  attribution: boolean;
}

/** Read the skill text and record which steps it actually states. */
export function detectSkillSteps(skillText: string): SkillSteps {
  const text = skillText.toLowerCase();
  return {
    scope: /set the scope|## scope|\bscope\b/.test(text) && /segment/.test(text),
    claimsVsEvidence:
      /separate claims from evidence|claims? (?:from|vs\.?|and) evidence|mark each item as/.test(text),
    featureTable: /feature comparison|feature table/.test(text),
    segmentTable: /segment comparison|segment table/.test(text),
    positioning: /positioning/.test(text),
    missingInfo: /missing information|state missing|missing-info/.test(text),
    unknownCells: /unknown/.test(text) && /do not guess|never guess|not guess/.test(text),
    attribution:
      /source for every fact|keep the source|date every fact|source.*next to the fact/.test(text),
  };
}

const REQUIRED_SECTIONS = [
  "scope",
  "feature comparison",
  "segment comparison",
  "positioning",
  "missing information",
];

type SourcedFact = FixtureFact & { _source: string; _date: string };

function factsFor(testCase: TestCase, company: string): SourcedFact[] {
  return testCase.documents
    .filter((d) => d.company === company)
    .flatMap((d) => d.facts.map((f) => ({ ...f, _source: d.source, _date: d.date })));
}

function allFacts(testCase: TestCase): SourcedFact[] {
  return testCase.documents.flatMap((d) =>
    d.facts.map((f) => ({ ...f, _source: d.source, _date: d.date })),
  );
}

function companyFact(testCase: TestCase, company: string, kind: string, key: string): SourcedFact | undefined {
  for (const doc of testCase.documents) {
    if (doc.company !== company) continue;
    const fact = doc.facts.find((f) => f.kind === kind && f.key === key);
    if (fact) return { ...fact, _source: doc.source, _date: doc.date };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

export function generateBaseline(testCase: TestCase): string {
  const lines: string[] = [];
  lines.push(`Notes on ${testCase.market}`);
  lines.push("");
  for (const company of testCase.companies) {
    const facts = factsFor(testCase, company) as SourcedFact[];
    const parts: string[] = [];
    for (const fact of facts) {
      if (fact.kind === "feature") parts.push(`${fact.key}: ${fact.value}`);
      else if (fact.kind === "pricing") parts.push(`${fact.key} is ${fact.value}`);
      else if (fact.kind === "segment") parts.push(`sells to ${fact.key}`);
      else parts.push(fact.value);
    }
    lines.push(`${company} is a company in ${testCase.market}. ${parts.join(". ")}.`);
  }
  // The generic procedure fills gaps with a market-leader sentence and
  // a guess for each missing item. No fixture supports either.
  lines.push(
    `${testCase.companies[0]} is widely seen as the market leader in ${testCase.market}.`,
  );
  for (const item of testCase.missing) {
    lines.push(`${item.company} ${item.topic} appears to be in line with the rest of the market.`);
  }
  return lines.join("\n") + "\n";
}

export function generateWithCapability(testCase: TestCase, skillText: string): string {
  const steps = detectSkillSteps(skillText);
  const facts = allFacts(testCase);
  const cite = (f: SourcedFact) =>
    steps.attribution ? ` (source: ${f._source}, ${f._date})` : "";
  const lines: string[] = [];
  lines.push(`# Competitor research: ${testCase.market}`);
  lines.push("");

  if (steps.scope) {
    lines.push("## Scope");
    const date = facts.length > 0 ? facts.map((f) => f._date).sort().slice(-1)[0] : "unknown";
    lines.push(
      `Market: ${testCase.market}. Companies: ${testCase.companies.join(", ")}. Segments: ${testCase.segments.join(", ")}. Research date: ${date}.`,
    );
    lines.push("");
  }

  if (steps.claimsVsEvidence) {
    lines.push("## Claims and evidence");
    for (const company of testCase.companies) {
      for (const fact of factsFor(testCase, company) as SourcedFact[]) {
        const tag = fact.claim ? "claim" : "evidence";
        lines.push(`- ${company}: ${fact.key}: ${fact.value} [${tag}]${cite(fact)}`);
      }
    }
    // Conflicting claims on one topic are stated as a disagreement.
    const claimsByTopic = new Map<string, SourcedFact[]>();
    for (const fact of facts) {
      if (!fact.claim || !fact.topic) continue;
      const list = claimsByTopic.get(fact.topic) ?? [];
      list.push(fact);
      claimsByTopic.set(fact.topic, list);
    }
    for (const [topic, claims] of claimsByTopic) {
      const values = new Set(claims.map((c) => c.value));
      if (claims.length > 1 && values.size > 1) {
        lines.push(
          `Sources disagree on ${topic}: ${claims.map((c) => `${c.value}${cite(c)}`).join("; ")}. The report states the disagreement instead of picking one.`,
        );
      }
    }
    lines.push("");
  }

  if (steps.featureTable) {
    const keys = [...new Set(facts.filter((f) => f.kind === "feature").map((f) => f.key))];
    lines.push("## Feature comparison");
    lines.push(`| Feature | ${testCase.companies.join(" | ")} |`);
    lines.push(`| --- | ${testCase.companies.map(() => "---").join(" | ")} |`);
    for (const key of keys) {
      const cells = testCase.companies.map((company) => {
        const fact = companyFact(testCase, company, "feature", key);
        if (fact) return fact.value;
        return steps.unknownCells ? "unknown" : "no";
      });
      lines.push(`| ${key} | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }

  if (steps.segmentTable) {
    lines.push("## Segment comparison");
    lines.push(`| Segment | ${testCase.companies.join(" | ")} |`);
    lines.push(`| --- | ${testCase.companies.map(() => "---").join(" | ")} |`);
    for (const segment of testCase.segments) {
      const cells = testCase.companies.map((company) => {
        const fact = companyFact(testCase, company, "segment", segment);
        if (fact) return fact.value;
        return steps.unknownCells ? "unknown" : "no";
      });
      lines.push(`| ${segment} | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }

  if (steps.positioning) {
    lines.push("## Positioning notes");
    for (const company of testCase.companies) {
      const fact = (factsFor(testCase, company) as SourcedFact[]).find(
        (f) => f.kind === "positioning",
      );
      if (fact) {
        const tag = steps.claimsVsEvidence ? (fact.claim ? " [claim]" : " [evidence]") : "";
        lines.push(`- ${company}: ${fact.value}${tag}${cite(fact)}`);
      } else {
        lines.push(`- ${company}: positioning not stated in the fixture documents.`);
      }
    }
    lines.push("");
  }

  if (steps.missingInfo) {
    lines.push("## Missing information");
    for (const item of testCase.missing) {
      lines.push(`- ${item.company} ${item.topic}: no source in the fixture documents. ${item.settle}`);
    }
    // Unknown table cells are missing information too.
    if (steps.featureTable && steps.unknownCells) {
      const keys = [...new Set(facts.filter((f) => f.kind === "feature").map((f) => f.key))];
      for (const key of keys) {
        for (const company of testCase.companies) {
          if (!companyFact(testCase, company, "feature", key)) {
            lines.push(`- ${company} ${key}: unknown, no source in the fixture documents.`);
          }
        }
      }
    }
    if (testCase.missing.length === 0) {
      lines.push("- No missing items in the fixture documents for this case.");
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function scoreOutput(testCase: TestCase, output: string): CaseScores {
  const lower = output.toLowerCase();
  const lines = output.split("\n");

  // Completeness: required sections present as headings or titles.
  const present = REQUIRED_SECTIONS.filter((s) => lower.includes(s)).length;
  const completeness = present / REQUIRED_SECTIONS.length;

  // Output structure: section headings plus a markdown table.
  const headings = lines.filter((l) => /^#{1,3}\s/.test(l) || /^##\s/.test(l)).length;
  const hasTable = lines.some((l) => l.trim().startsWith("|")) &&
    lines.some((l) => /^\|[\s:-]+\|/.test(l.trim()));
  const outputStructure = Math.min(1, headings / 4) * 0.6 + (hasTable ? 0.4 : 0);

  // Evidence attribution: distinctive fixture values that appear in the
  // output, and of those the share on a line that also names a source,
  // a date, or a claim/evidence tag.
  const distinctive = allFacts(testCase).filter(
    (f) => f.kind === "pricing" || f.kind === "positioning" || f.kind === "claim",
  );
  let mentioned = 0;
  let attributed = 0;
  for (const fact of distinctive) {
    const line = lines.find((l) => l.includes(fact.value));
    if (!line) continue;
    mentioned += 1;
    if (
      line.includes(fact._source) ||
      line.includes(fact._date) ||
      /\[(claim|evidence)\]/.test(line)
    ) {
      attributed += 1;
    }
  }
  const evidenceAttribution = mentioned === 0 ? 0 : attributed / mentioned;

  // Missing-data handling: missing items named inside a missing
  // information section.
  let missingDataHandling: number;
  if (testCase.missing.length === 0) {
    missingDataHandling = lower.includes("missing information") ? 1 : 0;
  } else {
    const sectionStart = lower.indexOf("missing information");
    let named = 0;
    if (sectionStart >= 0) {
      const section = lower.slice(sectionStart);
      for (const item of testCase.missing) {
        if (section.includes(item.company.toLowerCase()) && section.includes(item.topic.toLowerCase())) {
          named += 1;
        }
      }
    }
    missingDataHandling = named / testCase.missing.length;
  }

  // Unsupported assertions: sentences that name a company but carry no
  // fixture value, fixture key, source, date, or "unknown" marker.
  const supportedTokens = new Set<string>();
  for (const fact of allFacts(testCase)) {
    supportedTokens.add(fact.value.toLowerCase());
    supportedTokens.add(fact.key.toLowerCase());
    supportedTokens.add(fact._source.toLowerCase());
    supportedTokens.add(fact._date);
  }
  const sentences = output
    .split(/(?<=[.!])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let assertions = 0;
  let unsupported = 0;
  for (const sentence of sentences) {
    const s = sentence.toLowerCase();
    if (!testCase.companies.some((c) => s.includes(c.toLowerCase()))) continue;
    if (s.startsWith("#") || s.startsWith("| feature") || s.startsWith("| segment")) continue;
    assertions += 1;
    const supported =
      [...supportedTokens].some((t) => t.length >= 3 && s.includes(t)) ||
      s.includes("unknown") ||
      s.includes("disagree") ||
      s.includes("not stated");
    if (!supported) unsupported += 1;
  }
  const unsupportedAssertions = assertions === 0 ? 1 : 1 - unsupported / assertions;

  const scores = {
    completeness: round3(completeness),
    evidenceAttribution: round3(evidenceAttribution),
    missingDataHandling: round3(missingDataHandling),
    outputStructure: round3(outputStructure),
    unsupportedAssertions: round3(unsupportedAssertions),
    overall: 0,
  };
  scores.overall = round3(
    (scores.completeness +
      scores.evidenceAttribution +
      scores.missingDataHandling +
      scores.outputStructure +
      scores.unsupportedAssertions) /
      5,
  );
  return scores;
}

function meanScores(runs: Array<{ scores: CaseScores }>): CaseScores {
  const keys: Array<keyof CaseScores> = [
    "completeness",
    "evidenceAttribution",
    "missingDataHandling",
    "outputStructure",
    "unsupportedAssertions",
    "overall",
  ];
  const out = {} as CaseScores;
  for (const key of keys) {
    out[key] = runs.length === 0 ? 0 : round3(runs.reduce((sum, r) => sum + r.scores[key], 0) / runs.length);
  }
  return out;
}

/** Run the paired harness over a suite. */
export function runHarness(suite: TestSuiteData, skillText: string): {
  result: BehavioralResult;
  evidence: EvidenceItem[];
} {
  const evidence: EvidenceItem[] = [];
  const cases: CaseRun[] = [];
  for (const testCase of suite.cases) {
    const baselineOutput = generateBaseline(testCase);
    const withOutput = generateWithCapability(testCase, skillText);
    const baselineScores = scoreOutput(testCase, baselineOutput);
    const withScores = scoreOutput(testCase, withOutput);
    evidence.push({
      id: `evidence:${suite.suite_id}:${testCase.id}:baseline`,
      caseId: testCase.id,
      run: "baseline",
      output: baselineOutput,
    });
    evidence.push({
      id: `evidence:${suite.suite_id}:${testCase.id}:with-capability`,
      caseId: testCase.id,
      run: "with-capability",
      output: withOutput,
    });
    cases.push({
      caseId: testCase.id,
      baseline: { output: baselineOutput, scores: baselineScores },
      withCapability: { output: withOutput, scores: withScores },
      result: withScores.overall > baselineScores.overall ? "VERIFIED_FOR_TEST_SUITE" : "TESTED",
    });
  }

  const aggregate =
    cases.length > 0
      ? {
          baseline: meanScores(cases.map((c) => ({ scores: c.baseline.scores }))),
          withCapability: meanScores(cases.map((c) => ({ scores: c.withCapability.scores }))),
        }
      : null;

  let label: BehavioralResult["label"];
  let summary: string;
  if (cases.length === 0 || !aggregate) {
    label = "INSUFFICIENT_EVIDENCE";
    summary = "The test suite named no cases with fixture documents, so no behavioral run was possible.";
  } else if (cases.every((c) => c.result === "VERIFIED_FOR_TEST_SUITE")) {
    label = "VERIFIED_FOR_TEST_SUITE";
    summary = `With-capability runs beat the baseline on all ${cases.length} cases (aggregate overall ${aggregate.withCapability.overall} against baseline ${aggregate.baseline.overall}). The claim covers this suite and this fixture set only.`;
  } else if (cases.some((c) => c.result === "VERIFIED_FOR_TEST_SUITE")) {
    label = "TESTED";
    summary = `With-capability runs beat the baseline on ${cases.filter((c) => c.result === "VERIFIED_FOR_TEST_SUITE").length} of ${cases.length} cases (aggregate overall ${aggregate.withCapability.overall} against baseline ${aggregate.baseline.overall}).`;
  } else {
    label = "INSUFFICIENT_EVIDENCE";
    summary = `The with-capability runs did not beat the baseline on any case (aggregate overall ${aggregate.withCapability.overall} against baseline ${aggregate.baseline.overall}), so the suite gives no evidence the capability helps.`;
  }

  return {
    result: {
      label,
      performed: cases.length > 0,
      suite: { id: suite.suite_id, version: suite.version },
      cases,
      aggregate,
      summary,
    },
    evidence,
  };
}

/**
 * Merge the public case list of the competitor-research example with
 * fixture documents keyed by case id. Public cases carry prose
 * descriptions of their sources; the fixture documents are the
 * synthetic notes those descriptions name.
 */
export function buildSuiteFromPublicCases(
  publicCases: unknown,
  fixtureDocsByCaseId: Record<string, TestCase["documents"]>,
  fixtureMissingByCaseId: Record<string, TestCase["missing"]>,
): TestSuiteData {
  const parsed = publicCases as {
    suite_id: string;
    version: string;
    cases: Array<{
      id: string;
      input: { companies: string[]; market: string; segments: string[] };
    }>;
  };
  return {
    suite_id: parsed.suite_id,
    version: parsed.version,
    cases: parsed.cases.map((c) => ({
      id: c.id,
      task: `Research the companies in ${c.input.market} and write a comparison report.`,
      market: c.input.market,
      segments: c.input.segments,
      companies: c.input.companies,
      documents: fixtureDocsByCaseId[c.id] ?? [],
      missing: fixtureMissingByCaseId[c.id] ?? [],
    })),
  };
}
