export function computeConfidence(
  baseConfidence: number,
  successCount: number,
  failureCount: number,
): number {
  const base = Math.min(1, Math.max(0, baseConfidence));
  const total = successCount + failureCount + 2;
  return Math.min(1, Math.max(0, (successCount + base * 2) / total));
}
