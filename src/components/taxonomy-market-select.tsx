"use client";

import { storefrontPath } from "@/config/storefront-path";
import type { MarketId } from "@/config/markets";
import { TaxonomyFeedback, useConfirmTaxonomyNavigation, useTaxonomyOperation } from "./taxonomy-controls";

export function TaxonomyMarketSelect({ markets, selected }: { markets: { id: MarketId; name: string }[]; selected?: MarketId }) {
  const operation = useTaxonomyOperation();
  const confirm = useConfirmTaxonomyNavigation();

  async function switchMarket(marketId: string) {
    if (!marketId || !confirm()) return;
    await operation.run(async () => {
      const result = await fetch(storefrontPath("/api/staff/catalog/context"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ marketId }),
      });
      if (!result.ok) throw new Error("This market could not be selected for your staff account.");
    }, "Market selected.");
  }

  return <div className="taxonomy-market">
    <label>Working market
      <select value={selected ?? ""} disabled={operation.pending} onChange={event => switchMarket(event.currentTarget.value)}>
        {!selected && <option value="">Choose a market</option>}
        {markets.map(market => <option key={market.id} value={market.id}>{market.name}</option>)}
      </select>
    </label>
    <TaxonomyFeedback {...operation} />
  </div>;
}
