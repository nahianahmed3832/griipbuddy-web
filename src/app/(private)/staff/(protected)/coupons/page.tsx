import { notFound } from "next/navigation";
import Link from "next/link";
import { createCoupon, setCouponEnabled } from "@/app/staff/coupon-actions";
import { StaffActionForm } from "@/components/staff-actions";
import { formatMoney, marketIds } from "@/config/markets";
import { getDb } from "@/lib/db/client";
import { isMarketSelectable, marketConfiguration } from "@/lib/market-config";
import { currentMarket } from "@/lib/market-server";
import { sellerVisibility } from "@/lib/marketplace/market-grants";
import { marketplaceMode } from "@/lib/release-config";
import { getStaff } from "@/lib/staff/access";

export const metadata = { title: "Coupons" };

export default async function StaffCoupons({ searchParams }: { searchParams: Promise<{ market?: string }> }) {
  if (!marketplaceMode() || (await getStaff())?.role !== "OWNER") notFound();
  const [query, current] = await Promise.all([searchParams, currentMarket()]);
  const market = marketConfiguration(isMarketSelectable(query.market) ? query.market : current.id);
  const db = getDb();
  const [coupons, shops] = await Promise.all([
    db.marketplaceCoupon.findMany({ where: { marketId: market.id }, orderBy: { createdAt: "desc" }, take: 100, include: { shop: { select: { name: true } } } }),
    db.marketplaceShop.findMany({ where: sellerVisibility(market.id), orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const counts = await db.order.groupBy({
    by: ["couponCode"], where: { marketId: market.id, couponCode: { in: coupons.map(coupon => coupon.code) } }, _count: true,
  });
  const uses = new Map(counts.map(row => [row.couponCode, row._count]));
  const now = new Date();
  const expiry = new Intl.DateTimeFormat(market.defaultLocale, { dateStyle: "medium", timeZone: market.timeZone });
  return <>
    <h1>Coupons</h1>
    <nav className="staff-filters" aria-label="Coupon markets">
      {marketIds.filter(isMarketSelectable).map(id => <Link key={id} href={`/staff/coupons?market=${id}`}
        aria-current={market.id === id ? "page" : undefined}>{marketConfiguration(id).name}</Link>)}
    </nav>
    <div className="commerce-layout">
      <section className="commerce-panel">
        <h2>Active and past codes</h2>
        {coupons.length === 0 ? <p>No coupons created.</p> : <ul className="purchased-items">
          {coupons.map(coupon => (
            <li key={coupon.code}>
              <div>
                <strong>{coupon.code}</strong>
                <p>{coupon.kind === "PERCENT" ? `${coupon.value / 100}%` : formatMoney(coupon.value, market)} · {coupon.shop?.name ?? "All shops"}</p>
                <p>{uses.get(coupon.code) ?? 0}{coupon.useLimit ? ` of ${coupon.useLimit}` : ""} used · {
                  !coupon.enabled ? "Disabled" : coupon.endsAt && coupon.endsAt <= now ? "Expired" : "Enabled"
                }</p>
                {coupon.minimumMinor > 0 && <p>Minimum {formatMoney(coupon.minimumMinor, market)}</p>}
                {coupon.endsAt && <p>Last day {expiry.format(new Date(coupon.endsAt.getTime() - 1))}</p>}
              </div>
              <StaffActionForm action={setCouponEnabled.bind(null, market.id, coupon.code, !coupon.enabled)} submitLabel={coupon.enabled ? "Disable" : "Enable"} secondary />
            </li>
          ))}
        </ul>}
      </section>
      <section className="commerce-panel">
        <h2>Create a coupon</h2>
        <StaffActionForm action={createCoupon.bind(null, market.id)} submitLabel="Create coupon">
          <label>Code<input name="code" minLength={3} maxLength={32} pattern="[A-Za-z0-9](?:[A-Za-z0-9]|-){2,31}" required /></label>
          <label>Shop<select name="shop"><option value="">All shops</option>{shops.map(shop => <option key={shop.id} value={shop.id}>{shop.name}</option>)}</select></label>
          <label>Discount type<select name="kind"><option value="PERCENT">Percentage</option><option value="FIXED">Fixed {market.currency} amount</option></select></label>
          <label>Discount value<input name="value" type="number" min="0.01" max="100000" step="0.01" required /></label>
          <label>Minimum eligible merchandise ({market.currency}, optional)<input name="minimum" type="number" min="0" max="100000" step="0.01" /></label>
          <label>Order limit (optional)<input name="useLimit" type="number" min="1" max="100000" step="1" /></label>
          <label>Last day ({market.timeZone}, optional)<input name="endsAt" type="date" /></label>
        </StaffActionForm>
      </section>
    </div>
  </>;
}
