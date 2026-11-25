import type { Result, StructuredError } from "./errors.js";

/**
 * Transfer state is two independent dimensions.
 * Lifecycle tracks custody and approval. Verification tracks the
 * verification run. Neither dimension borrows states from the other.
 */

export const LIFECYCLE_STATES = [
  "DRAFT",
  "AWAITING_SENDER_APPROVAL",
  "OFFERED",
  "RECEIVED",
  "INSPECTED",
  "ACCEPTED",
  "REJECTED",
  "REVOKED",
  "EXPIRED",
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const VERIFICATION_STATES = [
  "NOT_STARTED",
  "PENDING",
  "VERIFIED",
  "FAILED",
] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

/**
 * Legal lifecycle transitions, exported as data so the spec table,
 * implementations, and tests all read the same table. A transition to
 * the current state is always an idempotent no-op and is not listed.
 */
export const LEGAL_LIFECYCLE_TRANSITIONS: Readonly<
  Record<LifecycleState, readonly LifecycleState[]>
> = {
  DRAFT: ["AWAITING_SENDER_APPROVAL", "REVOKED", "EXPIRED"],
  AWAITING_SENDER_APPROVAL: ["OFFERED", "DRAFT", "REVOKED", "EXPIRED"],
  OFFERED: ["RECEIVED", "REJECTED", "REVOKED", "EXPIRED"],
  RECEIVED: ["INSPECTED", "REJECTED", "REVOKED", "EXPIRED"],
  INSPECTED: ["ACCEPTED", "REJECTED", "REVOKED", "EXPIRED"],
  ACCEPTED: ["REVOKED"],
  REJECTED: [],
  REVOKED: [],
  EXPIRED: [],
};

/** Legal verification transitions. VERIFIED and FAILED may return to
 * PENDING when a new verification run starts. */
export const LEGAL_VERIFICATION_TRANSITIONS: Readonly<
  Record<VerificationState, readonly VerificationState[]>
> = {
  NOT_STARTED: ["PENDING"],
  PENDING: ["VERIFIED", "FAILED"],
  VERIFIED: ["PENDING"],
  FAILED: ["PENDING"],
};

export interface TransferState {
  lifecycle: LifecycleState;
  verification: VerificationState;
}

export const INITIAL_TRANSFER_STATE: TransferState = {
  lifecycle: "DRAFT",
  verification: "NOT_STARTED",
};

function illegal(
  dimension: string,
  from: string,
  to: string,
): { ok: false; errors: StructuredError[] } {
  return {
    ok: false,
    errors: [
      {
        code: "ILLEGAL_TRANSITION",
        path: `/${dimension}`,
        message: `illegal ${dimension} transition ${from} -> ${to}`,
      },
    ],
  };
}

/**
 * Move the lifecycle dimension. Transitioning to the current state is
 * an idempotent no-op and succeeds (for example, revoking a transfer
 * that is already REVOKED). Any other unlisted transition fails with
 * code ILLEGAL_TRANSITION and leaves the state unchanged.
 */
export function transitionLifecycle(
  state: TransferState,
  to: LifecycleState,
): Result<TransferState> {
  if (to === state.lifecycle) return { ok: true, value: state };
  if (!LEGAL_LIFECYCLE_TRANSITIONS[state.lifecycle].includes(to)) {
    return illegal("lifecycle", state.lifecycle, to);
  }
  return { ok: true, value: { ...state, lifecycle: to } };
}

/** Move the verification dimension. Same idempotency rule as lifecycle. */
export function transitionVerification(
  state: TransferState,
  to: VerificationState,
): Result<TransferState> {
  if (to === state.verification) return { ok: true, value: state };
  if (!LEGAL_VERIFICATION_TRANSITIONS[state.verification].includes(to)) {
    return illegal("verification", state.verification, to);
  }
  return { ok: true, value: { ...state, verification: to } };
}

export function canTransitionLifecycle(
  from: LifecycleState,
  to: LifecycleState,
): boolean {
  return from === to || LEGAL_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function canTransitionVerification(
  from: VerificationState,
  to: VerificationState,
): boolean {
  return from === to || LEGAL_VERIFICATION_TRANSITIONS[from].includes(to);
}
