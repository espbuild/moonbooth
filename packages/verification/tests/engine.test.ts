import { describe, it, expect } from "vitest";
import { validatePackage } from "@moonbooth/protocol";
import {
  assessCompatibility,
  detectSkillSteps,
  runVerification,
  verifySecurity,
} from "../src/index.js";
import { goodPackage, manifestInput } from "./helpers.js";
import { buildPackage } from "@moonbooth/protocol";

const profile = {
  adapter_id: "test-env",
  available_tools: ["web-search"],
  granted_permissions: { network: true },
};

describe("structural verification", () => {
  it("validates a good package and binds the receipt to its digest", () => {
    const pkg = goodPackage();
    const result = runVerification({ manifest: pkg.manifest, files: pkg.files, profile, env: {} });
    expect(result.structural.label).toBe("VALIDATED");
    expect(result.structural.checks.every((c) => c.ok)).toBe(true);
    expect(result.receipt.artifact_digest).toBe(pkg.digest);
    expect(result.receipt.structural_result).toBe("VALIDATED");
    expect(result.overall).toBe("VERIFIED");
  });

  // Adversarial scenario 11: mismatched digest.
  it("fails structural verification when a file byte changes after the digest was taken", () => {
    const pkg = goodPackage();
    const tampered = pkg.files.map((f) =>
      f.path === "SKILL.md"
        ? { ...f, content: new TextEncoder().encode("# Sample\n\nChanged after digesting.\n") }
        : f,
    );
    const result = runVerification({ manifest: pkg.manifest, files: tampered, profile, env: {} });
    expect(result.structural.label).toBe("FAILED");
    expect(result.structural.checks.find((c) => c.id === "digest_integrity")?.ok).toBe(false);
    expect(result.overall).toBe("FAILED");
    expect(result.receipt.structural_result).toBe("FAILED");
  });

  it("fails when the recorded digest does not match the stored bytes", () => {
    const pkg = goodPackage();
    const result = runVerification({
      manifest: pkg.manifest,
      files: pkg.files,
      profile,
      expectedDigest: "0".repeat(64),
      env: {},
    });
    expect(result.structural.label).toBe("FAILED");
    expect(result.structural.checks.find((c) => c.id === "recorded_digest_matches")?.ok).toBe(false);
  });

  it("reports a missing entrypoint and a missing test manifest as failed checks", () => {
    const pkg = goodPackage();
    const check = validatePackage({
      manifest: pkg.manifest,
      files: pkg.files.filter((f) => f.path === "references/notes.md"),
    });
    expect(check.ok).toBe(false);
    const result = runVerification({
      manifest: pkg.manifest,
      files: pkg.files.filter((f) => f.path === "references/notes.md"),
      profile,
      env: {},
    });
    expect(result.structural.checks.find((c) => c.id === "entrypoint_present")?.ok).toBe(false);
    expect(result.structural.checks.find((c) => c.id === "test_manifest_present")?.ok).toBe(false);
  });
});

describe("security policy verification", () => {
  it("passes a clean package and states the limitation in plain words", () => {
    const pkg = goodPackage();
    const result = verifySecurity({ manifest: pkg.manifest, files: pkg.files });
    expect(result.label).toBe("POLICY_CHECKS_PASSED");
    expect(result.limitations ?? result.limitation).toBeTruthy();
    expect(result.limitation).toContain("does not prove a package is safe");
  });

  // Adversarial scenario 1 (verification side): a fake API key blocks.
  it("blocks on a fake API key in package source", () => {
    const fakeKey = "sk-proj-" + "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0";
    const pkg = buildPackage({
      manifest: manifestInput(),
      files: {
        "SKILL.md": `# Leaky\n\nUse this key: ${fakeKey}\n`,
        "tests/manifest.json": '{"suite_id":"sample","version":"1.0.0"}\n',
      },
    });
    const result = verifySecurity({ manifest: pkg.manifest, files: pkg.files });
    expect(result.label).toBe("FAILED");
    expect(result.findings.some((f) => f.kind === "secret_openai_api_key" && f.severity === "blocking")).toBe(true);
    expect(JSON.stringify(result.findings)).not.toContain(fakeKey);
  });

  it("flags external_side_effects as a policy flag, not a block", () => {
    const pkg = goodPackage({
      requested_permissions: { network: true, filesystem_write: false, external_side_effects: true },
    });
    const result = verifySecurity({ manifest: pkg.manifest, files: pkg.files });
    expect(result.label).toBe("POLICY_CHECKS_PASSED");
    expect(result.findings.some((f) => f.kind === "permission_policy_flag" && f.severity === "warning")).toBe(true);
  });

  it("never emits a global safe claim", () => {
    const pkg = goodPackage();
    const result = runVerification({ manifest: pkg.manifest, files: pkg.files, profile, env: {} });
    const text = JSON.stringify(result).toLowerCase();
    expect(text).not.toContain('"safe":true');
    expect(result.receipt.structural_result).not.toBe("SAFE" as never);
    expect(result.limitations.join(" ")).toContain("does not prove");
  });
});

describe("compatibility assessment", () => {
  it("returns unknown, never compatible, when the profile is absent or empty", () => {
    const pkg = goodPackage();
    expect(assessCompatibility({ manifest: pkg.manifest, profile: null }).outcome).toBe("unknown");
    expect(
      assessCompatibility({
        manifest: pkg.manifest,
        profile: { adapter_id: "", available_tools: [], granted_permissions: {} },
      }).outcome,
    ).toBe("unknown");
  });

  it("names the missing tool and the missing configuration", () => {
    const pkg = goodPackage({
      requirements: {
        tools: ["web-search", "spreadsheet"],
        configuration: [{ name: "api_base", required: true }],
      },
    });
    const result = assessCompatibility({ manifest: pkg.manifest, profile });
    expect(result.outcome).toBe("missing_dependencies");
    expect(result.missingTools).toEqual(["spreadsheet"]);
    expect(result.missingConfiguration).toEqual(["api_base"]);
    expect(result.reasons.join(" ")).toContain("spreadsheet");
  });

  it("reports compatible_with_adaptation when a requested permission is ungranted", () => {
    const pkg = goodPackage({
      requirements: { tools: ["web-search"], configuration: [] },
      requested_permissions: { network: true, filesystem_write: true, external_side_effects: false },
    });
    const result = assessCompatibility({ manifest: pkg.manifest, profile });
    expect(result.outcome).toBe("compatible_with_adaptation");
    expect(result.ungrantedPermissions).toEqual(["filesystem_write"]);
    expect(result.adaptations[0]).toContain("filesystem_write");
  });

  it("reports compatible when the profile covers the manifest", () => {
    const pkg = goodPackage({ requirements: { tools: ["web-search"], configuration: [] } });
    const result = assessCompatibility({ manifest: pkg.manifest, profile });
    expect(result.outcome).toBe("compatible");
  });

  // Adversarial scenario 6 (compatibility side): a denied tool is unsupported.
  it("reports unsupported when the manifest requires a denylisted tool", () => {
    const pkg = goodPackage({ requirements: { tools: ["shell"], configuration: [] } });
    const result = assessCompatibility({
      manifest: pkg.manifest,
      profile: { ...profile, available_tools: ["shell"] },
    });
    expect(result.outcome).toBe("unsupported");
  });
});

describe("model grader hook", () => {
  it("reports NOT_TESTED when ANTHROPIC_API_KEY is not set", () => {
    const pkg = goodPackage();
    const result = runVerification({ manifest: pkg.manifest, files: pkg.files, profile, env: {} });
    expect(result.modelGrader.status).toBe("NOT_TESTED");
    expect(result.unsupportedChecks.some((c) => c.includes("model grader"))).toBe(true);
  });
});

describe("skill step detection", () => {
  it("detects the steps the competitor-research skill states", () => {
    const steps = detectSkillSteps(
      "Set the scope with segments. Separate claims from evidence. Build a feature comparison and a segment comparison. Write positioning notes. State missing information. Use unknown and do not guess. Keep the source for every fact next to the fact and date every fact.",
    );
    expect(steps).toEqual({
      scope: true,
      claimsVsEvidence: true,
      featureTable: true,
      segmentTable: true,
      positioning: true,
      missingInfo: true,
      unknownCells: true,
      attribution: true,
    });
  });

  it("detects no steps in a bare skill", () => {
    const steps = detectSkillSteps("Do the task and report back.");
    expect(Object.values(steps).every((v) => v === false)).toBe(true);
  });
});
