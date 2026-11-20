import { requireStaff } from "@/lib/staff/access";
import { currentMarket } from "@/lib/market-server";
import { selectedMarketId } from "@/lib/market-config";
import { CatalogCopyWorkspace } from "@/components/catalog-copy-workspace";

export const metadata = { title: "Catalog copy assistant", robots: { index: false, follow: false } };

export default async function StaffCatalogCopy({ searchParams }: { searchParams: Promise<{ market?: string; product?: string }> }) {
  const [staff, market, query] = await Promise.all([requireStaff(), currentMarket(), searchParams]);
  return <CatalogCopyWorkspace actor={{kind:"staff",id:staff.id}} marketId={selectedMarketId(query.market, market.id)}
    product={typeof query.product === "string" ? query.product.slice(0,120) : undefined} back="/staff/intelligence"/>;
}
