/**
 * Structured errors shared by every protocol operation.
 * Validators return these; builders throw them wrapped in ProtocolError.
 */
export interface StructuredError {
  /** Machine-readable code, e.g. "DIGEST_MISMATCH". */
  code: string;
  /** JSON-pointer style path into the offending value, when applicable. */
  path?: string;
  /** AJV keyword that produced the error, for schema failures. */
  keyword?: string;
  message: string;
}

export class ProtocolError extends Error {
  readonly code: string;
  readonly errors: StructuredError[];

  constructor(errors: StructuredError[]) {
    super(errors.map((e) => `${e.code}: ${e.message}`).join("; "));
    this.name = "ProtocolError";
    this.code = errors[0]?.code ?? "PROTOCOL_ERROR";
    this.errors = errors;
  }
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; errors: StructuredError[] };
