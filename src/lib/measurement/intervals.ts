export function wilsonInterval(successes: number, n: number, z = 1.96) {
  if (!n) return null;
  const share = successes / n;
  const scale = 1 + z ** 2 / n;
  const center = (share + z ** 2 / (2 * n)) / scale;
  const radius = z * Math.sqrt(share * (1 - share) / n + z ** 2 / (4 * n ** 2)) / scale;
  return [Math.max(0, center - radius), Math.min(1, center + radius)] as const;
}
