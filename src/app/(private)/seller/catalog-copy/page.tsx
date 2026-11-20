import { notFound } from "next/navigation";
import { CatalogCopyWorkspace } from "@/components/catalog-copy-workspace";
import { getShopper } from "@/lib/marketplace/auth";
import { resolveSellerAccess } from "@/lib/marketplace/seller-access";
import { currentMarket } from "@/lib/market-server";
import { selectedMarketId } from "@/lib/market-config";
import { marketplaceMode } from "@/lib/release-config";

export const metadata = { title: "Seller catalog copy assistant", robots: { index: false, follow: false } };

export default async function SellerCatalogCopy({ searchParams }: { searchParams: Promise<{ market?: string; shop?: string; product?: string }> }) {
  if (!marketplaceMode()) notFound();
  const [shopper, market, query] = await Promise.all([getShopper(), currentMarket(), searchParams]);
  if (!shopper) notFound();
  const selected = selectedMarketId(query.market,market.id);
  const access = await resolveSellerAccess(shopper.id, selected, "LISTINGS", query.shop);
  if (!access) notFound();
  const back = "/seller/listings?" + new URLSearchParams({market:selected,shop:access.shop.id});
  return <CatalogCopyWorkspace actor={{kind:"seller",id:shopper.id,shopId:access.shop.id}} marketId={selected}
    product={typeof query.product === "string" ? query.product.slice(0,120) : undefined} back={back} />;
}
