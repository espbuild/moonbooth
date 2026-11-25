import { ProtocolError } from "./errors.js";
import { validateReceiptShape } from "./manifest.js";
import { RECEIPT_VERSION, type ResultLabel } from "./schemas.js";

export type HumanApprovalStatus =
  | "APPROVED"
  | "REJECTED"
  | "PENDING"
  | "NOT_REQUIRED";
export type AdoptionStatus = "ADOPTED" | "NOT_ADOPTED" | "PENDING";

export interface ActReceipt {
  receipt_version: string;
  transfer_id: string;
  capability: { id: string; version: string };
  artifact_digest: string;
  timestamp: string;
  environment: { adapter_id: string; description?: string };
  structural_result: ResultLabel;
  security_result: ResultLabel;
  compatibility_result: ResultLabel;
  behavioral_outcomes: Array<{
    test_id: string;
    result: ResultLabel;
    notes?: string;
  }>;
  test_suite: { id: string; version: string };
  evidence_references: string[];
  baseline_comparison: {
    performed: boolean;
    result?: ResultLabel | null;
    summary?: string;
  };
  missing_checks: string[];
  unsupported_checks: string[];
  human_approval_status: HumanApprovalStatus;
  adoption_status: AdoptionStatus;
}

export type ReceiptInput = Omit<
  ActReceipt,
  "receipt_version" | "timestamp"
> & {
  timestamp?: string;
};

/**
 * Build a receipt and validate it against the receipt schema.
 * Defaults: receipt_version is the current version; timestamp is the
 * current time in UTC. Throws ProtocolError if the result is invalid.
 * A receipt records what a verification run observed. It does not by
 * itself grant adoption; adoption_status is a separate field set by
 * the recipient's approval step.
 */
export function buildReceipt(input: ReceiptInput): ActReceipt {
  const receipt: ActReceipt = {
    ...input,
    receipt_version: RECEIPT_VERSION,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  const check = validateReceiptShape(receipt);
  if (!check.ok) throw new ProtocolError(check.errors);
  return receipt;
}

/** Validate an unknown value as a receipt. */
export function validateReceipt(input: unknown): ActReceipt {
  const check = validateReceiptShape(input);
  if (!check.ok) throw new ProtocolError(check.errors);
  return input as ActReceipt;
}
