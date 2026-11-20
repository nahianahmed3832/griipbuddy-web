"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { formatMoney, type Market } from "@/config/markets";
import { localizedStorePath, regionalMarket } from "@/config/regional-path";
import { useCart, useCartActions } from "@/lib/cart/browser";
import { MAX_QUANTITY } from "@/lib/cart/model";
import { CatalogReadError, loadExactCatalogVariant, type CatalogVariant } from "@/lib/catalog/browser-catalog";
import type { getConnectedProduct } from "@/lib/catalog/connected-product";
import { personalizationAvailable, personalizationText } from "@/lib/catalog/personalization";
import { chooseProductOption, readProductChoice, writeProductChoice } from "@/lib/catalog/product-choice";
import { trackMeasurement, useProductMeasurement } from "@/lib/measurement/browser";
import { ConnectedProductDelivery, type ProductDelivery, type ProductDeliveryChoice } from "./connected-product-delivery";
import { ConnectedProductGallery } from "./connected-product-gallery";
import { ConnectedProductOptions } from "./connected-product-options";
import { PersonalizationField } from "./personalization-field";
import { QuantityControl } from "./quantity-control";
import { ShareProductSelection } from "./share-product-selection";
import "./connected-product-detail.css";

type ConnectedProduct = NonNullable<Awaited<ReturnType<typeof getConnectedProduct>>>;
type Check = { variant?: CatalogVariant; error?: string; unavailable?: boolean };

function Specifications({ data, selected, locale }: { data: ConnectedProduct; selected?: CatalogVariant; locale: string }) {
  const specsId = useId();
  const compatibilityId = useId();
  const attributes = data.attributes.flatMap(attribute => {
    const source = attribute.scope === "VARIANT" ? selected?.attributes : data.product.attributes;
    const value = source && Object.hasOwn(source, attribute.id) ? source[attribute.id] : undefined;
    const formatted = typeof value === "boolean" ? value ? "Yes" : "No"
      : typeof value === "number" ? new Intl.NumberFormat(locale).format(value) : value;
    return formatted === undefined ? [] : [{ label: attribute.name, value: formatted }];
  });
  const specs = new Map([...data.product.specifications, ...attributes].map(spec => [spec.label, spec.value]));
  if (data.product.brand) specs.set("Brand", data.product.brand);
  return <details className="connected-product-details" open>
    <summary>Item details</summary>
    <p className="product-detail__description">{data.product.description}</p>
    {specs.size > 0 && <section className="specifications" aria-labelledby={specsId}>
      <h2 id={specsId}>Specifications</h2>
      <dl>{[...specs].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </section>}
    {!!selected?.compatibility.length && <section className="connected-product-compatibility" aria-labelledby={compatibilityId}>
      <h2 id={compatibilityId}>Compatibility</h2>
      <ul>{selected.compatibility.map(model => {
        const brand = model.brand.trim();
        const name = model.name.trim();
        const branded = name.toLocaleLowerCase(locale).startsWith(`${brand.toLocaleLowerCase(locale)} `);
        return <li key={model.id}>{brand && !branded ? `${brand} ${name}` : name}</li>;
      })}</ul>
    </section>}
  </details>;
}

function ProductTerms({ variant, market, timeZone }: { variant?: CatalogVariant; market: Market; timeZone: string }) {
  const offer = variant?.offer;
  const amount = offer?.eligible && offer.marketId === market.id && offer.currency === market.currency &&
    Number.isSafeInteger(offer.amountMinor) && offer.amountMinor >= 0 ? offer.amountMinor : undefined;
  const compare = amount !== undefined && offer && Number.isSafeInteger(offer.regularMinor) &&
    offer.regularMinor > amount ? offer.regularMinor : undefined;
  const promotionEnds = compare !== undefined && offer?.promotionEndsAt;
  return <div className="connected-product-terms" data-selected={variant ? true : undefined}>
    <div aria-live="polite" aria-atomic="true">
      {amount !== undefined && <p className="product-detail__price"><data value={amount}>{formatMoney(amount, market)}</data>
        {compare !== undefined && <> <span className="sr-only">Regular price </span><del>{formatMoney(compare, market)}</del></>}
      </p>}
      {promotionEnds && <p className="product-detail__note">Sale ends <time dateTime={promotionEnds}>
        {new Intl.DateTimeFormat(market.locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(promotionEnds))}
      </time>.</p>}
    </div>
    {variant && <p className="product-detail__note">SKU {variant.sku}</p>}
    {!!variant?.options.length && <dl className="connected-product-selection" aria-label="Selected options">
      {variant.options.map(option => <div key={option.optionId ?? option.key}>
        <dt>{option.label}</dt><dd>{option.valueLabel}</dd>
      </div>)}
    </dl>}
  </div>;
}

export function ConnectedProductDetail({ data, market, deliveryChoices, postalRequired, timeZone, archivedVariantId, hasLegacyOffers }: {
  data: ConnectedProduct; market: Market; deliveryChoices: readonly ProductDeliveryChoice[];
  postalRequired: boolean; timeZone: string; archivedVariantId?: string; hasLegacyOffers?: boolean;
}) {
  const { product, options: axes, variants, personalization } = data;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams.toString());
  const choice = readProductChoice(axes, variants, params);
  const initial = choice.selected;
  const [delivery, setDelivery] = useState<ProductDelivery | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [lookup, setLookup] = useState<{ key: string; check?: Check }>({ key: "" });
  const [quantity, setQuantity] = useState({ variantId: "", value: 1 });
  const [personalizationDraft, setPersonalizationDraft] = useState("");
  const [choiceNotice, setChoiceNotice] = useState<{ search: string; axes: string[] }>();
  const [feedback, setFeedback] = useState<{ key: string; ok: boolean; text: string }>();
  const [addingKey, setAddingKey] = useState<string>();
  const { items, ready, sync } = useCart();
  const { addToCart } = useCartActions();
  const availabilityId = useId();

  const { id: marketId, locale, currency } = market;
  const variantId = initial?.id;
  const requestParams = new URLSearchParams();
  if (delivery) {
    requestParams.set("country", market.countryCode);
    requestParams.set("district", delivery.district);
    requestParams.set("method", delivery.method);
    requestParams.set("paymentMethod", delivery.paymentMethod);
    if (delivery.postalCode) requestParams.set("postalCode", delivery.postalCode);
  }
  const deliveryQuery = requestParams.toString();
  const offerId = initial?.offer.id;
  const selectionKey = variantId && offerId ? JSON.stringify([marketId, locale, product.id, variantId, deliveryQuery, offerId]) : "";
  const requestKey = selectionKey ? `${selectionKey}:${refresh}` : "";
  if (lookup.key !== requestKey) setLookup({ key: requestKey });

  useEffect(() => {
    if (!requestKey || !variantId) return;
    const controller = new AbortController();
    const finish = (check: Check) => {
      if (!controller.signal.aborted) setLookup(current => current.key === requestKey ? { key: requestKey, check } : current);
    };
    async function checkVariant(selectedVariantId: string) {
      try {
        const variant = await loadExactCatalogVariant(product.id, selectedVariantId, { id: marketId, locale, currency }, deliveryQuery, controller.signal);
        if (variant.offer.id !== offerId) {
          finish({ unavailable: true, error: "This offer changed. Reload the page to review current options." });
          return;
        }
        finish({ variant });
      } catch (error) {
        finish(error instanceof CatalogReadError && error.status === 404
          ? { unavailable: true } : { error: "Price and availability couldn’t be refreshed. Try again." });
      }
    }
    void checkVariant(variantId);
    return () => controller.abort();
  }, [requestKey, variantId, offerId, product.id, deliveryQuery, marketId, locale, currency]);

  const currentCheck = lookup.key === requestKey ? lookup.check : undefined;
  const checked = currentCheck?.variant;
  const selected = currentCheck?.unavailable ? undefined : checked ?? initial;
  const exactOffer = checked?.offer;
  const limit = Math.min(MAX_QUANTITY, checked?.quantityLimit ?? 0);
  const allocated = items.filter(line => line.variantId === selected?.id)
    .reduce((sum, line) => sum + line.quantity, 0);
  const remaining = Math.max(0, limit - allocated);
  const chosenQuantity = quantity.variantId === selected?.id ? Math.max(1, Math.min(quantity.value, remaining)) : 1;
  const note = personalization ? personalizationText(personalizationDraft) : undefined;
  const validPersonalization = (!personalization || !personalizationDraft.trim() || Boolean(note)) && personalizationAvailable(personalization, note);
  const readyToAdd = Boolean(delivery && exactOffer?.id && exactOffer.eligible && checked?.availability === "available" &&
    remaining >= chosenQuantity && validPersonalization && ready && sync !== "saving" && !addingKey);
  const legacySelection = hasLegacyOffers && selected?.offer.eligible && !selected.offer.id;
  const measured = selected?.offer.eligible && (!selected.offer.id || checked) ? selected : undefined;
  useProductMeasurement(product.id, measured?.id ?? "", market.id, measured?.offer.amountMinor, Boolean(measured), measured?.offer.id ?? undefined);

  function selectOption(axisId: string, valueId: string) {
    const current = new URLSearchParams(window.location.search);
    const before = readProductChoice(axes, variants, current);
    const next = chooseProductOption(axes, variants, before.picks, axisId, valueId);
    if (!next) return;
    const query = writeProductChoice(current, axes, next.picks, next.selected?.id).toString();
    if (query === current.toString()) return;
    setChoiceNotice({ search: query, axes: next.cleared });
    setFeedback(undefined);
    setQuantity({ variantId: next.selected?.id ?? "", value: 1 });
    const href = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    window.history.pushState(null, "", href);
    if (next.selected && next.selected.id !== before.selected?.id) {
      const { id, offer } = next.selected;
      trackMeasurement({ action: "VARIANT_SELECTION", marketId: market.id, productId: product.id, variantId: id,
        offerId: offer.id ?? undefined, placement: "product-detail" });
    }
  }

  function confirmDelivery(next: ProductDelivery | null) {
    setDelivery(next);
    setFeedback(undefined);
    if (next) setRefresh(value => value + 1);
  }

  async function add() {
    if (!readyToAdd || !checked || !exactOffer?.id) return;
    const liveChoice = readProductChoice(axes, variants, new URLSearchParams(window.location.search));
    if (liveChoice.selected?.id !== checked.id) return;
    setAddingKey(selectionKey);
    let added = false;
    try {
      added = await addToCart(checked.id, chosenQuantity, limit, note,
        { productId: product.id, priceMinor: exactOffer.amountMinor, placement: "product-detail" }, exactOffer.id);
    } catch {
      // Keep the checked variant visible and show the same retry path for a failed request.
    } finally {
      setFeedback({ key: selectionKey, ok: added, text: added ? `Added ${chosenQuantity} to your cart.`
        : "Your cart couldn’t be updated. Check the latest price and availability and try again." });
      if (!added) setRefresh(value => value + 1);
      setAddingKey(undefined);
    }
  }

  const partial = axes.flatMap(axis => axis.values.find(value => value.id === choice.picks[axis.id])?.label ?? []);
  let status = "Choose the product options to see its price and delivery availability.";
  if (selected) status = selected.offer.id && selected.offer.eligible && deliveryChoices.length
    ? "Check delivery for this variant." : `Purchasing is unavailable in ${market.name}.`;
  if (legacySelection) status = "Continue with this variant to review purchase options.";
  switch (checked?.availability) {
    case "available": status = "Available for your delivery selection."; break;
    case "out_of_stock": status = "Out of stock for this delivery."; break;
    case "delivery_unavailable": status = "This variant can’t be delivered using the selected service."; break;
  }
  if (requestKey && !currentCheck) status = delivery ? "Checking delivery…" : "Checking current price…";
  if (currentCheck?.unavailable) status = `This variant is unavailable in ${market.name}. Choose another option.`;
  if (currentCheck?.error) status = currentCheck.error;
  const cleared = choiceNotice?.search === params.toString() ? choiceNotice.axes : [];
  const policies = new URLSearchParams({ market: market.id, lang: market.locale });
  const policyLink = (topic: "delivery" | "returns") => {
    const path = `/help/${topic}`;
    return `${regionalMarket(pathname) ? localizedStorePath(path, market.id) : path}?${policies}`;
  };
  const reset = choice.issue ? writeProductChoice(params, axes, {}) : undefined;
  reset?.set("market", market.id);
  reset?.set("lang", market.locale);
  return <div className="product-detail connected-product-detail">
    <ConnectedProductGallery key={selected?.id ?? "parent"} sharedImages={product.images} variant={selected} />
    <div className="product-detail__info">
      <header className="connected-product-heading">
        <h1 className="display-type">{product.name}</h1>
        {product.shortDescription && <p className="product-detail__description">{product.shortDescription}</p>}
      </header>
      {choice.issue === "unavailable" && <p className="connected-choice-notice" role="status">
        {archivedVariantId && archivedVariantId === params.get("variant") ? "This variant has been archived." : `This variant is unavailable in ${market.name}.`}
        {" "}Choose another available option.
      </p>}
      {choice.issue === "invalid" && <p className="connected-choice-notice" role="status">This link contains an invalid variant. Choose from the available options.</p>}
      {choice.issue === "invalid-options" && <p className="connected-choice-notice" role="status">The options in this link don’t match a variant here. Update the options to continue.</p>}
      {reset && <p className="connected-product-recovery"><Link href={`${pathname}?${reset}`} prefetch={false} className="text-link">
        {axes.length ? "View product options" : "View available variant"}
      </Link></p>}
      <ConnectedProductOptions axes={axes} variants={variants} picks={choice.picks} onChoose={selectOption} />
      {!!cleared.length && <p className="connected-choice-notice" role="status">Choose {cleared.join(" and ")} again for this option.</p>}
      {!selected && !choice.issue && partial.length > 0 && <p className="product-detail__note">Matching options {partial.join(" · ")}</p>}
      <ProductTerms variant={selected} market={market} timeZone={timeZone} />
      {deliveryChoices.length > 0 && !legacySelection && <ConnectedProductDelivery choices={deliveryChoices} postalRequired={postalRequired}
        active={delivery} onCheck={confirmDelivery} />}
      <p id={availabilityId} className={checked?.availability === "available" ? "availability availability--yes" : "product-detail__note"} role="status">
        {status}
      </p>
      {currentCheck?.error && !currentCheck.unavailable && !delivery && <button type="button" className="button button--outline"
        onClick={() => setRefresh(value => value + 1)}>Retry price check</button>}
      {currentCheck?.error && currentCheck.unavailable && <button type="button" className="button button--outline"
        onClick={() => window.location.reload()}>Reload product</button>}
      {checked?.availability === "available" && <p className="product-detail__note">
        Availability can change before you place your order.
      </p>}
      {checked && checked.availability === "available" && limit > 0 && <>
        {personalization && <PersonalizationField settings={personalization} value={personalizationDraft} onChange={setPersonalizationDraft} />}
        {remaining > 0 && <QuantityControl value={chosenQuantity} max={remaining}
          onChange={value => setQuantity({ variantId: checked.id, value })} />}
        {remaining === 0 && <p className="product-detail__note">Your cart already contains the available quantity.</p>}
      </>}
      <div className="connected-product-purchase">
        {legacySelection ? <a href={`?${params}`} className="button button--primary">Continue with this variant</a>
          : <button type="button" className="button button--primary" aria-describedby={availabilityId} disabled={!readyToAdd} onClick={() => void add()}>
          {addingKey === selectionKey ? "Adding…" : "Add to cart"}
        </button>}
        {feedback?.key === selectionKey && <p className={`add-feedback${feedback.ok ? "" : " add-feedback--error"}`} role="status">
          <span>{feedback.text}</span> <Link href="/cart">View cart</Link>
        </p>}
      </div>
      <ShareProductSelection slug={product.slug} market={market} variantId={selected?.id}
        picks={choice.issue || currentCheck?.unavailable ? undefined : choice.picks} />
      <Specifications data={data} selected={selected} locale={market.locale} />
      <nav className="mp-panel-links" aria-label="Product policies">
        <Link href={policyLink("delivery")}>Delivery details</Link><Link href={policyLink("returns")}>Return policy</Link>
      </nav>
    </div>
  </div>;
}
