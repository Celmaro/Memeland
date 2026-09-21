/**
 * Legacy environment guard for injected code paths.
 *
 * File-backed strategy and indicator modules run in short-lived child processes.
 * This helper remains for injected test doubles and other synchronous legacy
 * paths that cannot use the worker proxy.
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
