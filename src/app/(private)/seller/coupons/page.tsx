import { notFound, redirect } from "next/navigation";
import { formatMoney } from "@/config/markets";
import { SellerEmpty, SellerPageHeader, SellerStatus } from "@/components/marketplace/seller-ui";
import { SignInGate } from "@/components/marketplace/session";
import { currentMarket } from "@/lib/market-server";
import { sellerWorkspace } from "@/lib/marketplace/seller-workspace";
import { listSellerCoupons } from "@/lib/marketplace/seller-coupons";
import { firstPartyStoreMode, marketplaceMode } from "@/lib/release-config";
import { OperationError } from "@/lib/staff/operation-error";
import { SellerCouponForm } from "./coupon-form";

export const metadata = { title: "Seller coupons" };

export default async function SellerCoupons() {
  if (!marketplaceMode() || firstPartyStoreMode()) notFound();
  const [{ shopper, shop }, market] = await Promise.all([sellerWorkspace(), currentMarket()]);
  if (!shopper) return <SignInGate>Sign in to manage coupons.</SignInGate>;
  if (!shop) redirect("/seller");
  let coupons;
  try { coupons = await listSellerCoupons(shopper.id, market.id); }
  catch (error) {
    if (!(error instanceof OperationError)) throw error;
    return <SellerEmpty title="Coupons unavailable">{error.message}</SellerEmpty>;
  }
  const formatDate = new Intl.DateTimeFormat(market.locale, { dateStyle: "medium", timeZone: market.timeZone });
  return <>
    <SellerPageHeader title="Coupons" description={`${market.name} · ${market.currency}`}/>
    <section className="seller-panel">
      <div className="seller-panel-heading"><div><h2>Create a shop coupon</h2>
        <p className="seller-muted">The discount applies only to this shop’s items in the selected market.</p></div></div>
      <SellerCouponForm key={market.id} marketId={market.id} currency={market.currency}/>
    </section>
    <section className="seller-panel" aria-labelledby="seller-coupon-list">
      <div className="seller-panel-heading"><h2 id="seller-coupon-list">Saved coupons</h2></div>
      {coupons.length ? <div className="seller-table-wrap"><table className="seller-table" aria-labelledby="seller-coupon-list">
        <thead><tr>{["Code", "Discount", "Status", "Expires", "Action"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{coupons.map(coupon => {
          const expired = coupon.endsAt && coupon.endsAt <= new Date();
          return <tr key={coupon.code}>
            <td data-label="Code"><strong>{coupon.code}</strong></td>
            <td data-label="Discount">{coupon.kind === "PERCENT" ? `${coupon.value / 100}%` : formatMoney(coupon.value, market)}</td>
            <td data-label="Status"><SellerStatus tone={coupon.enabled && !expired ? "positive" : "muted"}>
              {expired ? "Expired" : coupon.enabled ? "Active" : "Disabled"}</SellerStatus></td>
            <td data-label="Expires">{coupon.endsAt ? formatDate.format(coupon.endsAt) : "—"}</td>
            <td data-label="Action">{coupon.sellerAuthorId === shopper.id && coupon.enabled && !expired
              ? <SellerCouponForm marketId={market.id} currency={market.currency} code={coupon.code}/>
              : coupon.sellerAuthorId === shopper.id ? "—" : "Managed by GriipBuddy"}</td>
          </tr>;
        })}</tbody>
      </table></div> : <SellerEmpty title="No coupons in this market"/>}
    </section>
  </>;
}
