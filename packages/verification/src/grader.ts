import type { ModelGraderResult } from "./types.js";

/**
 * Model grader hook.
 *
 * A model-backed grader is optional configuration. When
 * ANTHROPIC_API_KEY is not set, the grader does not run and reports
 * NOT_TESTED. This build never calls a network API from the
 * verification path, so even with a key set the grader reports
 * NOT_TESTED and says why, rather than inventing a grade.
 */
export function runModelGrader(env: Record<string, string | undefined>): ModelGraderResult {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) {
    return {
      status: "NOT_TESTED",
      reason: "ANTHROPIC_API_KEY is not set, so the optional model grader did not run.",
    };
  }
  return {
    status: "NOT_TESTED",
    reason:
      "A key is present, but this build of the verification engine does not call a model API. The model grader did not run.",
  };
}
