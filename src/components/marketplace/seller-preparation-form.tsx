"use client";

import { storefrontPath } from "@/config/storefront-path";
import type { MarketId } from "@/config/markets";
import type { SellerPreparationStatus } from "@/generated/prisma/enums";
import { sellerPreparationActions } from "@/lib/marketplace/seller-preparation";
import { useMarketplaceSubmission } from "./action-form";

export function SellerPreparationForm({ orderId, marketId, shopId, next }: { orderId: string; marketId: MarketId; shopId?: string; next: SellerPreparationStatus }) {
  const save = useMarketplaceSubmission();
  return (
    <form className="mp-form" onSubmit={event => {
      event.preventDefault();
      void save.submit(async () => {
        const response = await fetch(storefrontPath("/api/marketplace/seller/fulfillment"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId, marketId, shopId, next }),
        });
        if (!response.ok) {
          const error = await response.json().catch(() => null);
          throw new Error(error?.message ?? "Couldn't update shop preparation.");
        }
      }, "Shop preparation updated.");
    }}>
      <button className="button button--outline" type="submit" disabled={save.pending}>
        {save.pending ? "Saving…" : sellerPreparationActions[next]}
      </button>
      {save.feedback}
    </form>
  );
}
