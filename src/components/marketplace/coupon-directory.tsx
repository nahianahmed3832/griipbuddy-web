import Link from "next/link";
import { formatMoney, type Market } from "@/config/markets";
import { marketConfiguration } from "@/lib/market-config";
import { listedCoupons } from "@/lib/marketplace/coupon-directory";
import { CopyCoupon } from "./copy-coupon";
import styles from "./coupon-directory.module.css";

export async function CouponDirectory({ market }: { market: Market }) {
  const coupons = await listedCoupons(market.id);
  const expiry = new Intl.DateTimeFormat(market.locale, { dateStyle: "medium", timeZone: marketConfiguration(market.id).timeZone });
  const percent = new Intl.NumberFormat(market.locale, { style: "percent", maximumFractionDigits: 2 });
  return <section className={styles.directory} aria-labelledby="coupon-directory-title">
    <h1 id="coupon-directory-title">Coupons</h1>
    <p>Published offers for {market.name}. Checkout confirms the discount against your eligible items and current availability.</p>
    {coupons.length ? <ul className={styles.grid}>{coupons.map(coupon => <li key={coupon.code}>
      <h2>{coupon.kind === "PERCENT" ? percent.format(coupon.value / 10_000) : formatMoney(coupon.value, market)} off</h2>
      <p>{coupon.shop ? <Link href={`/shops/${coupon.shop.slug}`}>{coupon.shop.name}</Link> : "Eligible items from any shop"}</p>
      {coupon.minimumMinor > 0 && <p>Minimum eligible subtotal {formatMoney(coupon.minimumMinor, market)}</p>}
      {coupon.endsAt && <p>Last day {expiry.format(new Date(coupon.endsAt.getTime() - 1))}</p>}
      <div className={styles.code}><code>{coupon.code}</code><CopyCoupon code={coupon.code}/></div>
    </li>)}</ul> : <p>No coupons are currently listed for this market. <Link href="/shop">Browse the shop</Link>.</p>}
  </section>;
}
