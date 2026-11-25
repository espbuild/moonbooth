// Deterministic seeding and counterbalanced condition ordering.
//
// Counterbalancing follows a Latin-square rotation: for a run at
// position `p` in the plan (variant index combined with repetition),
// the condition order is the scenario's condition list rotated by
// (p + seedOffset), where seedOffset is derived from the recorded
// seed. The same seed always produces the same plan; across a full
// square of runs, every condition occupies every position equally.

/** mulberry32: small deterministic PRNG, stable across Node versions. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normalize any seed (number or string) to a uint32. */
export function normalizeSeed(seed: number | string): number {
  if (typeof seed === "number" && Number.isFinite(seed)) return seed >>> 0;
  const s = String(seed);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rotate<T>(items: readonly T[], offset: number): T[] {
  const n = items.length;
  if (n === 0) return [];
  const k = ((offset % n) + n) % n;
  return [...items.slice(k), ...items.slice(0, k)];
}

/**
 * The condition execution order for the run at plan position `p`.
 * The seed shifts the whole square so different seeds start from
 * different rotations while preserving the counterbalance property.
 */
export function conditionOrder<T>(
  conditions: readonly T[],
  planPosition: number,
  seed: number | string,
): T[] {
  const offset = planPosition + (normalizeSeed(seed) % Math.max(1, conditions.length));
  return rotate(conditions, offset);
}
