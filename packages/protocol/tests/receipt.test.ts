import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  RESULT_LABELS,
  buildReceipt,
  validateReceipt,
  type ReceiptInput,
} from "../src/index.js";

const input: ReceiptInput = {
  transfer_id: "transfer-123",
  capability: { id: "competitor-research", version: "1.0.0" },
  artifact_digest: "a".repeat(64),
  environment: { adapter_id: "act-reference-adapter" },
  structural_result: "VALIDATED",
  security_result: "POLICY_CHECKS_PASSED",
  compatibility_result: "TESTED",
  behavioral_outcomes: [
    { test_id: "case-1", result: "TESTED", notes: "ran against fixture" },
  ],
  test_suite: { id: "competitor-research-public", version: "1.0.0" },
  evidence_references: ["evidence/run-1/log.txt"],
  baseline_comparison: { performed: true, result: "TESTED", summary: "baseline ran" },
  missing_checks: [],
  unsupported_checks: ["model-graded-scoring"],
  human_approval_status: "PENDING",
  adoption_status: "PENDING",
};

describe("receipts", () => {
  it("builds a schema-valid receipt with version and timestamp filled", () => {
    const receipt = buildReceipt(input);
    expect(receipt.receipt_version).toBe("0.1");
    expect(receipt.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(validateReceipt(receipt)).toEqual(receipt);
  });

  it("keeps an explicit timestamp", () => {
    const receipt = buildReceipt({ ...input, timestamp: "2026-11-21T12:00:00Z" });
    expect(receipt.timestamp).toBe("2026-11-21T12:00:00Z");
  });

  it("accepts every result label in the enum", () => {
    for (const label of RESULT_LABELS) {
      const receipt = buildReceipt({ ...input, structural_result: label });
      expect(receipt.structural_result).toBe(label);
    }
  });

  it("rejects a result label outside the enum", () => {
    expect(() =>
      buildReceipt({
        ...input,
        // @ts-expect-error testing runtime validation
        structural_result: "SAFE",
      }),
    ).toThrow(ProtocolError);
  });

  it("rejects a receipt with a missing required field", () => {
    const bad = { ...buildReceipt(input) } as Record<string, unknown>;
    delete bad.adoption_status;
    expect(() => validateReceipt(bad)).toThrow(ProtocolError);
  });

  it("rejects a receipt with an unknown field", () => {
    const bad = { ...buildReceipt(input), verdict: "safe" };
    expect(() => validateReceipt(bad)).toThrow(ProtocolError);
  });

  it("rejects a malformed digest and timestamp", () => {
    expect(() => buildReceipt({ ...input, artifact_digest: "xyz" })).toThrow(
      ProtocolError,
    );
    expect(() => buildReceipt({ ...input, timestamp: "not a date" })).toThrow(
      ProtocolError,
    );
  });
});
