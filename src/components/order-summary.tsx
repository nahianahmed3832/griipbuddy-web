import Link from "next/link";
import { formatMoney, type Market } from "@/config/markets";
import type { OrderTotals, QuoteLine } from "@/lib/commerce/checkout-types";
import { cartItemKey } from "@/lib/cart/model";
import { purchasedOptions } from "@/lib/commerce/purchased-options";

export function OrderBreakdown({ totals, market, heading = "Order summary" }: {
  totals: OrderTotals;
  market: Market;
  heading?: string;
}) {
  const couponDiscount = totals.couponDiscountMinor ?? 0;
  const prepaidDiscount = totals.prepaidDiscountMinor ?? 0;
  const itemDiscount = totals.discountMinor - couponDiscount - prepaidDiscount;
  return (
    <section className="commerce-panel commerce-summary" aria-label={heading}>
      <h2>{heading}</h2>
      <dl>
        <div><dt>Items subtotal</dt><dd>{formatMoney(totals.subtotalMinor, market)}</dd></div>
        {itemDiscount > 0 && <div><dt>Item discounts</dt><dd>−{formatMoney(itemDiscount, market)}</dd></div>}
        {couponDiscount > 0 && <div><dt>Coupon {totals.couponCode}</dt><dd>−{formatMoney(couponDiscount, market)}</dd></div>}
        {prepaidDiscount > 0 && <div><dt>Prepaid discount (5%)</dt><dd>−{formatMoney(prepaidDiscount, market)}</dd></div>}
        <div><dt>Delivery</dt><dd>{formatMoney(totals.deliveryMinor, market)}</dd></div>
        <div><dt>{totals.taxLabel}</dt><dd>{formatMoney(totals.taxMinor, market)}</dd></div>
        <div className="commerce-summary__total"><dt>Order total</dt><dd>{formatMoney(totals.totalMinor, market)} <small>{market.currency}</small></dd></div>
      </dl>
    </section>
  );
}

type DisplayLine = Pick<QuoteLine, "variantId" | "productName" | "variantName" | "sku" | "quantity" | "unitPriceMinor" |
  "unitDiscountMinor" | "lineTotalMinor" | "personalization"> & {
    id?: string; optionsSnapshot?: unknown; marketplaceShopNameSnapshot?: string | null;
  };

export type ReorderOption = { href: string; currentPrice: string } | { message: string };

export function PurchasedItems({ lines, market, reorder }: {
  lines: readonly DisplayLine[]; market: Market; reorder?: ReadonlyMap<string, ReorderOption>;
}) {
  return (
    <ul className="purchased-items">
      {lines.map(line => {
        const option = line.id && reorder?.get(line.id);
        return <li key={line.id ?? cartItemKey(line)}>
          <div>
            <strong>{line.productName}</strong>
            <p>{purchasedOptions(line)} · {line.sku}</p>
            {line.marketplaceShopNameSnapshot && <p>{line.marketplaceShopNameSnapshot}</p>}
            {line.personalization && <p className="personalization-note">Personalization: {line.personalization}</p>}
            <p>{line.quantity} × {formatMoney(line.unitPriceMinor - line.unitDiscountMinor, market)}</p>
            {option && ("href" in option ? <p>
              <Link className="text-link" href={option.href} prefetch={false}
                aria-label={`Buy again · ${line.productName} · ${line.sku}`}>Buy again</Link>
              {" · "}Current price {option.currentPrice}
            </p> : <p>{option.message}</p>)}
          </div>
          <strong>{formatMoney(line.lineTotalMinor, market)}</strong>
        </li>;
      })}
    </ul>
  );
}
