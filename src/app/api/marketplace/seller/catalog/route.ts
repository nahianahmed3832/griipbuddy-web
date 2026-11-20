import { revalidatePath } from "next/cache";
import { handleCatalogMutation, sellerCatalogUnavailable } from "@/lib/catalog/admin-api";
import { currentMarket } from "@/lib/market-server";
import { getShopper } from "@/lib/marketplace/auth";
import { firstPartyStoreMode, marketplaceMode } from "@/lib/release-config";

export async function POST(request: Request) {
  if (!marketplaceMode() || firstPartyStoreMode()) return sellerCatalogUnavailable();
  const response = await handleCatalogMutation(request, {
    actor: async () => {
      const shopper = await getShopper();
      return shopper ? { kind: "seller", id: shopper.id } : null;
    },
    market: async () => (await currentMarket()).id,
  });
  if (response.ok) revalidatePath("/", "layout");
  return response;
}
