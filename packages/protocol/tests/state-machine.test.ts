import { describe, expect, it } from "vitest";
import {
  INITIAL_TRANSFER_STATE,
  LEGAL_LIFECYCLE_TRANSITIONS,
  LEGAL_VERIFICATION_TRANSITIONS,
  LIFECYCLE_STATES,
  VERIFICATION_STATES,
  canTransitionLifecycle,
  canTransitionVerification,
  transitionLifecycle,
  transitionVerification,
  type TransferState,
} from "../src/index.js";

const state = (
  lifecycle: TransferState["lifecycle"],
  verification: TransferState["verification"] = "NOT_STARTED",
): TransferState => ({ lifecycle, verification });

describe("lifecycle transitions", () => {
  it("allows every transition in the legal table", () => {
    for (const [from, targets] of Object.entries(LEGAL_LIFECYCLE_TRANSITIONS)) {
      for (const to of targets) {
        const result = transitionLifecycle(
          state(from as TransferState["lifecycle"]),
          to,
        );
        expect(result.ok, `${from} -> ${to}`).toBe(true);
        if (result.ok) expect(result.value.lifecycle).toBe(to);
      }
    }
  });

  it("rejects every transition not in the table", () => {
    for (const from of LIFECYCLE_STATES) {
      for (const to of LIFECYCLE_STATES) {
        if (from === to) continue;
        if (LEGAL_LIFECYCLE_TRANSITIONS[from].includes(to)) continue;
        const result = transitionLifecycle(state(from), to);
        expect(result.ok, `${from} -> ${to}`).toBe(false);
        if (!result.ok) {
          expect(result.errors[0].code).toBe("ILLEGAL_TRANSITION");
        }
        expect(canTransitionLifecycle(from, to)).toBe(false);
      }
    }
  });

  it("walks the happy path", () => {
    let s = INITIAL_TRANSFER_STATE;
    for (const to of [
      "AWAITING_SENDER_APPROVAL",
      "OFFERED",
      "RECEIVED",
      "INSPECTED",
      "ACCEPTED",
    ] as const) {
      const r = transitionLifecycle(s, to);
      expect(r.ok).toBe(true);
      if (r.ok) s = r.value;
    }
    expect(s.lifecycle).toBe("ACCEPTED");
  });

  it("treats same-state transitions as idempotent no-ops", () => {
    for (const s of LIFECYCLE_STATES) {
      const result = transitionLifecycle(state(s), s);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.lifecycle).toBe(s);
    }
    // The named case: revoking a REVOKED transfer succeeds as a no-op.
    const again = transitionLifecycle(state("REVOKED"), "REVOKED");
    expect(again.ok).toBe(true);
  });

  it("terminal states have no outgoing transitions", () => {
    for (const s of ["REJECTED", "REVOKED", "EXPIRED"] as const) {
      expect(LEGAL_LIFECYCLE_TRANSITIONS[s]).toEqual([]);
    }
  });
});

describe("verification transitions", () => {
  it("allows every transition in the legal table", () => {
    for (const [from, targets] of Object.entries(LEGAL_VERIFICATION_TRANSITIONS)) {
      for (const to of targets) {
        const result = transitionVerification(
          state("INSPECTED", from as TransferState["verification"]),
          to,
        );
        expect(result.ok, `${from} -> ${to}`).toBe(true);
      }
    }
  });

  it("rejects transitions not in the table", () => {
    for (const from of VERIFICATION_STATES) {
      for (const to of VERIFICATION_STATES) {
        if (from === to) continue;
        if (LEGAL_VERIFICATION_TRANSITIONS[from].includes(to)) continue;
        const result = transitionVerification(state("INSPECTED", from), to);
        expect(result.ok, `${from} -> ${to}`).toBe(false);
        expect(canTransitionVerification(from, to)).toBe(false);
      }
    }
  });

  it("supports re-verification from VERIFIED and FAILED", () => {
    expect(transitionVerification(state("INSPECTED", "VERIFIED"), "PENDING").ok).toBe(true);
    expect(transitionVerification(state("INSPECTED", "FAILED"), "PENDING").ok).toBe(true);
  });

  it("moves independently of the lifecycle dimension", () => {
    const r = transitionVerification(state("RECEIVED", "NOT_STARTED"), "PENDING");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.lifecycle).toBe("RECEIVED");
      expect(r.value.verification).toBe("PENDING");
    }
  });
});
