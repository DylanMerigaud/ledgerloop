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

/**
 * Exhaustiveness guard for a discriminated union. Put it in the `default` of a
 * switch (or the else of an if-chain): the parameter is typed `never`, so if a new
 * variant is ever added without a branch, the TYPE CHECK fails — the bug is caught
 * at compile time. If somehow reached at runtime, it throws clearly.
 */
export const assertUnreachable = (value: never): never => {
  throw new Error(`Unreachable case: ${JSON.stringify(value)}`);
};

/**
 * Type guard: a non-null object indexable by string. The honest narrowing of an
 * `unknown`/`object` to a record so we can read fields off it WITHOUT an `as` cast.
 */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;
