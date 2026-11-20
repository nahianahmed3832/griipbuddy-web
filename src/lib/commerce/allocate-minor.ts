// Allocate whole minor units and break equal remainders by input order.
export function allocateMinor(amount: number, weights: readonly number[]) {
  const totalWeight = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (amount === 0 || totalWeight === 0n) return weights.map(() => 0);
  const portions = weights.map((weight, index) => {
    const numerator = BigInt(amount) * BigInt(weight);
    return { index, amount: Number(numerator / totalWeight), remainder: numerator % totalWeight };
  });
  const remaining = amount - portions.reduce((sum, portion) => sum + portion.amount, 0);
  const remainderOrder = [...portions].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const portion of remainderOrder.slice(0, remaining)) portion.amount++;
  return portions.map(portion => portion.amount);
}
