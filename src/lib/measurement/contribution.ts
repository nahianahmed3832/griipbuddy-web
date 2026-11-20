const inputs = {
  revenueBeforeRefundsMinor: "Recognized revenue excluding tax",
  refundsMinor: "Refunds excluding tax",
  itemCostMinor: "Item cost",
  packagingMinor: "Packaging",
  outboundMinor: "Outbound fulfillment",
  returnMinor: "Return fulfillment",
  paymentFeesMinor: "Payment and collection fees",
} as const;

type Component = keyof typeof inputs;
export type ContributionRecord = Record<Component, number | null> & {
  currency: string;
  verifiedThrough: Date;
};

export function contributionProfit(orders: readonly {
  currency?: string;
  updatedAt?: Date;
  outcomes?: readonly { at: Date }[];
  contributionEvidence?: ContributionRecord | null;
}[]) {
  const missing = new Map<string, number>();
  let total = 0n;
  let verified = 0;
  const missingInput = (label: string) => missing.set(label, (missing.get(label) ?? 0) + 1);
  for (const order of orders) {
    const record = order.contributionEvidence;
    const usable = record && record.currency === order.currency && order.updatedAt &&
      record.verifiedThrough >= order.updatedAt && (order.outcomes ?? []).every(event => record.verifiedThrough >= event.at);
    if (!usable) {
      missingInput("Current reconciled financial evidence");
      continue;
    }
    const absent = (Object.keys(inputs) as Component[]).filter(key => {
      const value = record[key];
      return value === null || !Number.isSafeInteger(value) || value < 0;
    });
    if (absent.length) {
      absent.forEach(key => missingInput(inputs[key]));
      continue;
    }
    const [revenue, ...costs] = (Object.keys(inputs) as Component[]).map(key => BigInt(record[key]!));
    total += revenue - costs.reduce((sum, value) => sum + value, 0n);
    verified++;
  }
  return { total: orders.length > 0 && verified === orders.length ? total : null, verified, missing: [...missing] };
}
