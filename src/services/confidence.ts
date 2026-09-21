/**
 * Kernel — normalize a confidence score to a 0-1 fraction.
 * Accepts either 0-100 (percent) or 0-1 (already fraction) inputs, clamps to
 * range, and yields 0 for non-finite values (fail-closed). Removes the
 * off-by-100 class of bug where a percent leaks into a fraction field.
 */
export function confidenceToFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 1) return Math.max(0, Math.min(100, value)) / 100;
  return Math.max(0, Math.min(1, value));
}
