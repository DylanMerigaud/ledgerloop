/**
 * Standalone invariant assertion. Throws when `condition` is falsy, and narrows
 * the condition to truthy for the code that follows (`asserts condition`). It is
 * the honest alternative to `value ?? ""`: instead of silently papering a missing
 * value with an empty string and letting a logic bug surface far downstream, state
 * the invariant at the point it must hold and fail loudly with a named message if
 * it is ever violated.
 *
 * Intentionally self-contained (no imports, no app internals) so it can be lifted
 * verbatim into @dylanmerigaud/config later; call sites then swap this specifier
 * for the package one and nothing else changes.
 */
export const invariant: (condition: unknown, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) {
    throw new Error(`Invariant violated: ${message}`);
  }
};
