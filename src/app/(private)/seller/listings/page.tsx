import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, FileUp, Plus, Search } from "lucide-react";
import { SellerEmpty, SellerPageHeader, SellerPager, SellerStatus } from "@/components/marketplace/seller-ui";
import { sellerListingStates } from "@/components/marketplace/seller-listing-state";
import { SignInGate } from "@/components/marketplace/session";
import { formatMoney } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { getDb } from "@/lib/db/client";
import type { Prisma } from "@/generated/prisma/client";
import { currentMarket } from "@/lib/market-server";
import { sellerListingWorkspace } from "@/lib/marketplace/seller-workspace";
import { sellerConnectedProductScope } from "@/lib/staff/product-workspace-commerce";

export const metadata = { title: "Shop products" };

const pageSize = 20;
const statuses = { DRAFT: "Draft", ACTIVE: "Active catalog", ARCHIVED: "Archived" } as const;
type CatalogStatus = keyof typeof statuses;
type ReviewStatus = keyof typeof sellerListingStates;

export default async function SellerListingsPage({ searchParams }: {
  searchParams: Promise<{ q?: string | string[]; page?: string | string[]; status?: string | string[]; review?: string | string[] }>;
}) {
  const [query, market] = await Promise.all([searchParams, currentMarket()]);
  const { shopper, shop, delegated } = await sellerListingWorkspace(market.id);
  if (!shopper) return <div className="seller-entry">
    <SellerPageHeader title="Shop products" /><SignInGate>Sign in to manage your shop’s products.</SignInGate>
  </div>;
  if (!shop) redirect("/seller");
  const approved = shop.marketGrants.some(grant => grant.marketId === market.id && grant.status === "APPROVED");
  const canSell = approved && shop.published;
  const search = typeof query.q === "string" ? query.q.trim().slice(0, 120) : "";
  const status = typeof query.status === "string" && Object.hasOwn(statuses, query.status)
    ? query.status as CatalogStatus : undefined;
  const reviewStatus = typeof query.review === "string" && Object.hasOwn(sellerListingStates, query.review)
    ? query.review as ReviewStatus : undefined;
  const enteredPage = typeof query.page === "string" && /^\d{1,6}$/u.test(query.page) ? Number(query.page) : 1;
  const page = Math.max(1, enteredPage);
  const matches = { contains: search, mode: "insensitive" } as const;
  const sellerReviews = { marketId: market.id, product: { marketplaceShopId: shop.id } };
  const sellerVariants = { OR: [{ product: { marketplaceShopId: shop.id } },
    { offers: { some: { marketId: market.id, identity: { sellerId: shop.id, retiredAt: null } } } }],
  } satisfies Prisma.VariantWhereInput;
  const rows = await getDb().product.findMany({
    where: { AND: [
      { OR: [{ marketplaceShopId: shop.id, ...(delegated && {
        sellerListingReviews: { some: { marketId: market.id } },
      }) }, ...(canSell && !delegated ? [sellerConnectedProductScope(shop.id, [market.id])] : [])] },
      ...(status ? [{ publication: status }] : []),
      ...(reviewStatus ? [{ sellerListingReviews: { some: { ...sellerReviews, state: reviewStatus } } }] : []),
      ...(search ? [{ OR: [
        { name: matches },
        { variants: { some: { ...sellerVariants, sku: matches } } },
        { sellerListingReviews: { some: { ...sellerReviews,
          draft: { path: ["name"], string_contains: search, mode: "insensitive" as const },
        } } },
      ] }] : []),
    ] },
    orderBy: [{ addedOn: "desc" }, { name: "asc" }, { id: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize + 1,
    select: {
      id: true, name: true, publication: true, marketplaceShopId: true, foundation: true,
      sellerListingReviews: { where: sellerReviews, select: { state: true, draft: true } },
      variants: {
        where: sellerVariants,
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: {
          sku: true, active: true,
          offers: {
            where: { marketId: market.id, currency: market.currency, eligible: true, OR: [
              { identity: { sellerId: shop.id, retiredAt: null } },
              { offerId: null, variant: { product: { marketplaceShopId: shop.id } } },
            ] },
            select: { amountMinor: true, publication: true },
          },
        },
      },
    },
  });
  const pageHref = (page: number) => `/seller/listings?${new URLSearchParams({
    market: market.id, ...(search && { q: search }), ...(status && { status }), ...(reviewStatus && { review: reviewStatus }), page: String(page),
  })}`;
  const filtering = Boolean(search || status || reviewStatus);

  return <>
    <SellerPageHeader title="Shop products" description={`${shop.name} · ${market.name} · ${market.currency}`}
      actions={canSell ? <>
        {!delegated && <Link className="seller-button" href={`/seller/listings/exchange?market=${market.id}`} prefetch={false}>
          <FileUp size={16} aria-hidden="true"/> Import listings
        </Link>}
        <Link className="seller-button seller-button-primary" href={`/seller/listings/new?market=${market.id}`} prefetch={false}>
          <Plus size={16} aria-hidden="true"/> New listing
        </Link>
      </> : undefined}/>
    <section className="seller-panel">
      <div className="seller-panel-heading">
        <div><h2 id="seller-products-list">Products and offers</h2>
          <p className="seller-muted">Your catalog and offers assigned to your shop in {market.name}.</p></div>
      </div>
      {!approved && <p className="seller-muted">Want to sell in {market.name}? <Link href={`/seller?market=${market.id}#markets`}
        prefetch={false}>Manage market access</Link>.</p>}
      <form action={storefrontPath("/seller/listings")} method="get" className="seller-filters seller-product-filters" aria-label="Search shop products">
        <input type="hidden" name="market" value={market.id}/>
        <label>Product name or SKU <input type="search" name="q" defaultValue={search} maxLength={120}/></label>
        <label>Catalog status <select name="status" defaultValue={status ?? ""}>
          <option value="">All statuses</option>
          {Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>Review status <select name="review" defaultValue={reviewStatus ?? ""}>
          <option value="">All statuses</option>
          {Object.entries(sellerListingStates).map(([value, { label }]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <button type="submit" className="seller-button"><Search size={15} aria-hidden="true"/> Search</button>
        {filtering && <Link className="seller-button" href={`/seller/listings?market=${market.id}`} prefetch={false}>Clear filters</Link>}
      </form>
      {!rows.length ? <SellerEmpty title={filtering ? "No products match your filters" : page > 1 ? "No products on this page" : "No products yet"}>
        {filtering ? "Change the search or selected statuses." : "Your listings and eligible assigned offers will appear here."}
      </SellerEmpty> : <div className="seller-table-wrap"><table className="seller-table" aria-labelledby="seller-products-list">
        <thead><tr><th scope="col">Product</th><th scope="col">Catalog status</th><th scope="col">Review status</th>
          <th scope="col">{market.name} offer</th><th scope="col">Details</th></tr></thead>
        <tbody>{rows.slice(0, pageSize).map(row => {
          const detail = `/seller/listings/${row.id}?market=${market.id}`;
          const review = row.sellerListingReviews[0];
          const draftName = review?.draft && typeof review.draft === "object" && "name" in review.draft && typeof review.draft.name === "string"
            ? review.draft.name : null;
          const label = row.publication === "DRAFT" && draftName ? draftName : row.name;
          const reviewLabel = review && sellerListingStates[review.state];
          const activeOffers = row.variants.flatMap(variant => variant.active ? variant.offers : []);
          const publishedOffers = activeOffers.filter(offer => offer.publication === "ACTIVE");
          const displayedOffers = publishedOffers.length ? publishedOffers : activeOffers;
          const prices = displayedOffers.map(offer => offer.amountMinor);
          const price = prices.length ? formatMoney(Math.min(...prices), market) : null;
          const offerLabel = row.publication === "ACTIVE" && canSell && publishedOffers.length ? null
            : publishedOffers.length && !canSell ? "Selling unavailable" : "Not published for sale";
          return <tr key={row.id}>
            <td data-label="Product"><span><Link href={detail} prefetch={false}>{label}</Link>
              <small>{row.marketplaceShopId !== shop.id ? "Assigned catalog offer" : row.variants[0]?.sku ?? "Owned product"}</small></span></td>
            <td data-label="Catalog status"><span><SellerStatus tone={row.publication === "ACTIVE" ? "positive"
              : row.publication === "DRAFT" ? "warning" : "muted"}>{statuses[row.publication]}</SellerStatus></span></td>
            <td data-label="Review status"><span>{reviewLabel
              ? <SellerStatus tone={reviewLabel.tone}>{reviewLabel.label}</SellerStatus> : "—"}</span></td>
            <td data-label="Market offer" data-money><span>{price
              ? <>{new Set(prices).size > 1 ? "From " : ""}{price} {market.currency}{offerLabel && <small>{offerLabel}</small>}</>
              : "No offer in this market"}</span></td>
            <td data-label="Details"><Link className="seller-table-action" href={detail} prefetch={false}>
              {review?.state === "DRAFT" && canSell || row.publication === "DRAFT" && !row.foundation && approved ? "Edit draft" : "Open"}
              <ChevronRight size={14} aria-hidden="true"/><span className="seller-visually-hidden"> {label}</span>
            </Link>{canSell && row.marketplaceShopId === shop.id && <Link className="seller-table-action" prefetch={false}
              href={"/seller/catalog-copy?" + new URLSearchParams({ market: market.id, shop: shop.id, product: row.id })}>
              Review copy<span className="seller-visually-hidden"> for {label}</span>
            </Link>}</td>
          </tr>;
        })}</tbody>
      </table></div>}
      <SellerPager label="Product pages" page={page} hasNext={rows.length > pageSize} pageHref={pageHref}/>
    </section>
  </>;
}
