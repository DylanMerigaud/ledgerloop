/**
 * Explicit invariant assertions — the honest alternative to a silent `!`.
 *
 * Some values are provably non-null to a human (a Map key we just populated, the
 * head of a queue inside a `while (queue.length)`) but not to the type checker. A
 * bare `x!` asserts that without a word of why and crashes opaquely if it's ever
 * wrong. `nonNull(x, why)` states the invariant, and if it's violated throws a
 * message that names the cause — so a logic bug surfaces clearly instead of as a
 * downstream `undefined`.
 */
export const nonNull = <T>(value: T | null | undefined, why: string): T => {
  if (value == null) {
    throw new Error(`Invariant violated: ${why}`);
  }
  return value;
};
