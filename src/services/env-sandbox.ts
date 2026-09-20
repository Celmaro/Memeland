/**
 * Env sandbox for running untrusted (user/LLM-authored) code in-process.
 *
 * Strategy .mjs modules (and the LP evaluate path in the hub) run in the main
 * Node process. A crafted module could otherwise read private keys, API tokens,
 * or other secrets out of `process.env`, both at module-import time and inside
 * its evaluate/calculate call. `withClearedEnv` snapshots the environment,
 * empties it for the duration of `fn`, then restores every entry — so untrusted
 * code sees no process secrets regardless of where it runs.
 *
 * The restore mutates the existing env object in place (rather than assigning a
 * new object) so it behaves predictably on Windows.
 */
export function withClearedEnv<T>(fn: () => T): T {
  const snapshot = new Map<string, string>();
  for (const key of Object.keys(process.env)) {
    const value = process.env[key];
    if (value !== undefined) snapshot.set(key, value);
  }
  // Empty the environment before running untrusted code.
  for (const key of Object.keys(process.env)) delete process.env[key];
  try {
    return fn();
  } finally {
    // Restore the snapshot: wipe any keys introduced while cleared, then put the
    // original values back in place.
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const [key, value] of snapshot) process.env[key] = value;
  }
}
