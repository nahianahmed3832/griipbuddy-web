import type { Currency, Market } from "@/config/markets";
import type { OrderTotals, QuoteLine } from "@/lib/commerce/checkout-types";
import { customerOrderMoney } from "@/lib/commerce/account-order";
import { cartItemKey } from "@/lib/cart/model";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";

export function OrderBreakdown({ totals, market, language = "en", currency = market.currency, heading = accountText(language, "Order summary", "অর্ডারের সারসংক্ষেপ") }: {
  totals: OrderTotals;
  market: Market;
  language?: AccountLanguage;
  currency?: Currency;
  heading?: string;
}) {
  const couponDiscount = totals.couponDiscountMinor ?? 0;
  const prepaidDiscount = totals.prepaidDiscountMinor ?? 0;
  const itemDiscount = totals.discountMinor - couponDiscount - prepaidDiscount;
  const t = (english: string, bangla: string) => accountText(language, english, bangla);
  const money = (minor: number) => customerOrderMoney(minor, currency, language);
  return (
    <section className="commerce-panel commerce-summary" aria-label={heading}>
      <h2>{heading}</h2>
      <dl>
        <div><dt>{t("Items subtotal", "পণ্যের মোট")}</dt><dd>{money(totals.subtotalMinor)}</dd></div>
        {itemDiscount > 0 && <div><dt>{t("Item discounts", "পণ্যে ছাড়")}</dt><dd>−{money(itemDiscount)}</dd></div>}
        {couponDiscount > 0 && <div><dt>{t("Coupon", "কুপন")} {totals.couponCode}</dt><dd>−{money(couponDiscount)}</dd></div>}
        {prepaidDiscount > 0 && <div><dt>{t("Prepaid discount (5%)", "অগ্রিম পেমেন্টে ছাড় (৫%)")}</dt><dd>−{money(prepaidDiscount)}</dd></div>}
        <div><dt>{t("Delivery", "ডেলিভারি")}</dt><dd>{money(totals.deliveryMinor)}</dd></div>
        <div><dt>{language === "bn" ? (/trial|test/i.test(totals.taxLabel) ? "কর (পরীক্ষামূলক)" : "কর") : totals.taxLabel}</dt><dd>{money(totals.taxMinor)}</dd></div>
        <div className="commerce-summary__total"><dt>{t("Order total", "অর্ডারের মোট")}</dt><dd>{money(totals.totalMinor)} <small>{currency}</small></dd></div>
      </dl>
    </section>
  );
}

export function PurchasedItems({ lines, market, language = "en", currency = market.currency, showPersonalization = true, itemHelpHref }: {
  lines: readonly (QuoteLine & { id?: string })[]; market: Market; showPersonalization?: boolean; language?: AccountLanguage; currency?: Currency;
  itemHelpHref?: (id: string) => string;
}) {
  const number = new Intl.NumberFormat(language === "bn" ? "bn-BD" : market.locale);
  const money = (minor: number) => customerOrderMoney(minor, currency, language);
  return (
    <ul className="purchased-items">
      {lines.map((line, index) => (
        <li key={showPersonalization ? cartItemKey(line) : `${line.variantId}-${index}`}>
          <div>
            <strong>{line.productName}</strong>
            <p>{line.variantName} · {line.sku}</p>
            {showPersonalization && line.personalization && <p className="personalization-note">{accountText(language, "Personalization", "নিজস্ব লেখা")} · {line.personalization}</p>}
            <p>{number.format(line.quantity)} × {money(line.unitPriceMinor - line.unitDiscountMinor)}</p>
            {itemHelpHref && line.id && <p><a className="text-link" href={itemHelpHref(line.id)}>{accountText(language, "Get help with this item", "এই পণ্য নিয়ে সহায়তা নিন")}</a></p>}
          </div>
          <strong>{money(line.lineTotalMinor)}</strong>
        </li>
      ))}
    </ul>
  );
}
