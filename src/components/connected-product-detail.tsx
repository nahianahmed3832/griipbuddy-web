"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { formatMoney, type Market } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { useCart, useCartActions } from "@/lib/cart/browser";
import { MAX_QUANTITY } from "@/lib/cart/model";
import type { getConnectedProduct, getExactConnectedVariant } from "@/lib/catalog/connected-product";
import type { PublicCatalogVariant } from "@/lib/catalog/connected-public";
import { personalizationAvailable, personalizationText } from "@/lib/catalog/personalization";
import { chooseProductOption, readProductChoice, writeProductChoice } from "@/lib/catalog/product-choice";
import { trackMeasurement, useProductMeasurement } from "@/lib/measurement/browser";
import { ConnectedProductDelivery, type ProductDelivery, type ProductDeliveryChoice } from "./connected-product-delivery";
import { ConnectedProductOptions } from "./connected-product-options";
import { PersonalizationField } from "./personalization-field";
import { QuantityControl } from "./quantity-control";
import { ShareProductSelection } from "./share-product-selection";
import "./connected-product-detail.css";

type ConnectedProduct = NonNullable<Awaited<ReturnType<typeof getConnectedProduct>>>;
type ExactVariant = NonNullable<Awaited<ReturnType<typeof getExactConnectedVariant>>>;
type Check = { variant?: PublicCatalogVariant; error?: string; unavailable?: boolean };

function ProductGallery({ product, variant }: { product: ConnectedProduct["product"]; variant?: PublicCatalogVariant }) {
  const [pickedPhoto, pickPhoto] = useState<string>();
  const all = [...(variant?.image ? [variant.image] : []), ...(variant?.gallery ?? []), ...product.images];
  const seen = new Set<string>();
  const photos = all.filter(photo => {
    if (seen.has(photo.src)) return false;
    seen.add(photo.src);
    return true;
  });
  const current = photos.find(photo => photo.src === pickedPhoto) ?? photos[0];
  return <section className="product-gallery" aria-label="Product images">
    {current ? <div className="product-gallery__main">
      <Image src={storefrontPath(current.src)} alt={current.alt} fill unoptimized sizes="(max-width: 759px) 100vw, 580px" />
    </div> : <p className="commerce-muted">No product image is available.</p>}
    {photos.length > 1 && <div className="product-gallery__thumbs" role="group" aria-label="Choose product image">
      {photos.map((photo, index) => <button type="button" key={photo.src} aria-pressed={current?.src === photo.src}
        aria-label={`View image ${index + 1}: ${photo.alt}`} onClick={() => pickPhoto(photo.src)}>
        <Image src={storefrontPath(photo.src)} alt="" fill unoptimized sizes="76px" />
      </button>)}
    </div>}
  </section>;
}

function Specifications({ data, selected, locale }: { data: ConnectedProduct; selected?: PublicCatalogVariant; locale: string }) {
  const attributes = data.attributes.flatMap(attribute => {
    const source = attribute.scope === "VARIANT" ? selected?.attributes : data.product.attributes;
    const value = source?.[attribute.id];
    const formatted = typeof value === "boolean" ? value ? "Yes" : "No"
      : typeof value === "number" ? new Intl.NumberFormat(locale).format(value) : value;
    return formatted === undefined ? [] : [{ label: attribute.name, value: formatted }];
  });
  const specs = new Map([...data.product.specifications, ...attributes].map(spec => [spec.label, spec.value]));
  if (data.product.brand) specs.set("Brand", data.product.brand);
  return <details open>
    <summary>Item details</summary>
    <p className="product-detail__description">{data.product.description}</p>
    {specs.size > 0 && <dl className="specifications">
      {[...specs].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>}
    {!!selected?.compatibility.length && <p className="product-detail__note">
      Fits {selected.compatibility.map(model => `${model.brand} ${model.name}`).join(", ")}.
    </p>}
  </details>;
}

export function ConnectedProductDetail({ data, market, deliveryChoices, postalRequired, timeZone, archivedVariantId, hasLegacyOffers }: {
  data: ConnectedProduct; market: Market; deliveryChoices: readonly ProductDeliveryChoice[];
  postalRequired: boolean; timeZone: string; archivedVariantId?: string; hasLegacyOffers?: boolean;
}) {
  const { product, options: axes, variants, personalization } = data;
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
  const [adding, setAdding] = useState(false);
  const { items, ready, sync } = useCart();
  const { addToCart } = useCartActions();
  const availabilityId = useId();

  const variantId = initial?.id;
  const requestParams = new URLSearchParams({ market: market.id, lang: market.locale });
  if (delivery) {
    requestParams.set("country", market.countryCode);
    requestParams.set("district", delivery.district);
    requestParams.set("method", delivery.method);
    requestParams.set("paymentMethod", delivery.paymentMethod);
    if (delivery.postalCode) requestParams.set("postalCode", delivery.postalCode);
  }
  const offerId = initial?.offer.id;
  const request = variantId && offerId
    ? storefrontPath(`/api/catalog/products/${encodeURIComponent(product.id)}/variants/${encodeURIComponent(variantId)}?${requestParams}`)
    : null;
  const requestKey = request ? JSON.stringify([request, offerId, refresh]) : "";
  if (lookup.key !== requestKey) setLookup({ key: requestKey });

  useEffect(() => {
    if (!request || !variantId) return;
    const controller = new AbortController();
    const finish = (check: Check) => {
      if (!controller.signal.aborted) setLookup(current => current.key === requestKey ? { key: requestKey, check } : current);
    };
    const errorMessage = "Price and availability couldn’t be refreshed. Try again.";
    async function checkVariant() {
      try {
        const response = await fetch(request!, { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          if (response.status === 404) {
            finish({ unavailable: true });
            return;
          }
          throw new Error(errorMessage);
        }
        const result = await response.json() as ExactVariant;
        if (result.marketId !== market.id || result.locale !== market.locale || result.currency !== market.currency ||
          result.product.id !== product.id || result.variant.id !== variantId ||
          result.variant.offer.variantId !== variantId || result.variant.offer.marketId !== market.id ||
          result.variant.offer.currency !== market.currency) {
          throw new Error(errorMessage);
        }
        if (result.variant.offer.id !== offerId) {
          finish({ unavailable: true, error: "This offer changed. Reload the page to review current options." });
          return;
        }
        finish({ variant: result.variant });
      } catch {
        finish({ error: errorMessage });
      }
    }
    void checkVariant();
    return () => controller.abort();
  }, [request, requestKey, variantId, offerId, product.id, market.id, market.locale, market.currency]);

  const currentCheck = lookup.key === requestKey ? lookup.check : undefined;
  const checked = currentCheck?.variant;
  const selected = currentCheck?.unavailable ? undefined : checked ?? initial;
  const exactOffer = checked?.offer;
  const limit = Math.min(MAX_QUANTITY, checked?.quantityLimit ?? 0);
  const allocated = items.filter(line => line.variantId === selected?.id && line.offerId === exactOffer?.id)
    .reduce((sum, line) => sum + line.quantity, 0);
  const remaining = Math.max(0, limit - allocated);
  const chosenQuantity = quantity.variantId === selected?.id ? Math.max(1, Math.min(quantity.value, remaining)) : 1;
  const note = personalization ? personalizationText(personalizationDraft) : undefined;
  const validPersonalization = (!personalization || !personalizationDraft.trim() || Boolean(note)) && personalizationAvailable(personalization, note);
  const readyToAdd = Boolean(delivery && exactOffer?.id && exactOffer.eligible && checked?.availability === "available" &&
    remaining >= chosenQuantity && validPersonalization && ready && sync !== "saving" && !adding);
  const completedKey = `${selected?.id ?? ""}:${exactOffer?.id ?? ""}`;
  const legacySelection = hasLegacyOffers && selected?.offer.eligible && !selected.offer.id;
  useProductMeasurement(product.id, selected?.id ?? "", market.id, selected?.offer.amountMinor, Boolean(selected), selected?.offer.id ?? undefined);

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
        offerId: offer.id ?? undefined, displayedPriceMinor: offer.amountMinor, currency: market.currency, placement: "product-detail" });
    }
  }

  function confirmDelivery(next: ProductDelivery | null) {
    setDelivery(next);
    setFeedback(undefined);
    setRefresh(value => value + 1);
  }

  async function add() {
    if (!readyToAdd || !checked || !exactOffer?.id) return;
    setAdding(true);
    let added = false;
    try {
      added = await addToCart(checked.id, chosenQuantity, limit, note,
        { productId: product.id, priceMinor: exactOffer.amountMinor, placement: "product-detail" }, exactOffer.id);
    } catch {
      // Keep the checked variant visible and show the same retry path for a failed request.
    } finally {
      setFeedback({ key: completedKey, ok: added, text: added ? `Added ${chosenQuantity} to your cart.`
        : "Your cart couldn’t be updated. Check the latest price and availability and try again." });
      if (!added) setRefresh(value => value + 1);
      setAdding(false);
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
  if (request && !currentCheck) status = delivery ? "Checking delivery…" : "Checking current price…";
  if (currentCheck?.unavailable) status = `This variant is unavailable in ${market.name}. Choose another option.`;
  if (currentCheck?.error) status = currentCheck.error;
  const cleared = choiceNotice?.search === params.toString() ? choiceNotice.axes : [];
  const promotionEnds = selected?.offer.promotionEndsAt;
  return <div className="product-detail connected-product-detail">
    <ProductGallery key={selected?.id ?? "parent"} product={product} variant={selected} />
    <div className="product-detail__info">
      <h1 className="display-type">{product.name}</h1>
      {product.shortDescription && <p className="product-detail__description">{product.shortDescription}</p>}
      {choice.issue === "unavailable" && <p className="connected-choice-notice" role="status">
        {archivedVariantId && archivedVariantId === params.get("variant") ? "This variant has been archived." : `This variant is unavailable in ${market.name}.`}
        {" "}Choose another available option.
      </p>}
      {choice.issue === "invalid" && <p className="connected-choice-notice" role="status">This link contains an invalid variant. Choose from the available options.</p>}
      {choice.issue === "invalid-options" && <p className="connected-choice-notice" role="status">The options in this link don’t match a variant here. Update the options to continue.</p>}
      <ConnectedProductOptions axes={axes} variants={variants} picks={choice.picks} onChoose={selectOption} />
      {!!cleared.length && <p className="connected-choice-notice" role="status">Choose {cleared.join(" and ")} again for this option.</p>}
      {!selected && !choice.issue && partial.length > 0 && <p className="product-detail__note">Matching options {partial.join(" · ")}</p>}
      {selected && <div className="connected-product-terms" aria-live="polite">
        <p className="product-detail__price">{formatMoney(selected.offer.amountMinor, market)}
          {selected.offer.regularMinor > selected.offer.amountMinor && <del>{formatMoney(selected.offer.regularMinor, market)}</del>}
        </p>
        {promotionEnds && <p className="product-detail__note">Sale ends <time dateTime={promotionEnds}>
          {new Intl.DateTimeFormat(market.locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(promotionEnds))}
        </time>.</p>}
        <p className="product-detail__note">SKU {selected.sku}</p>
        {selected.options.length > 0 && <p className="product-detail__note">
          {selected.options.map(option => option.valueLabel).join(" · ")}
        </p>}
      </div>}
      {deliveryChoices.length > 0 && !legacySelection && <ConnectedProductDelivery choices={deliveryChoices} postalRequired={postalRequired}
        active={delivery} onCheck={confirmDelivery} />}
      <p id={availabilityId} className={checked?.availability === "available" ? "availability availability--yes" : "product-detail__note"} role="status">
        {status}
      </p>
      {currentCheck?.error && !currentCheck.unavailable && !delivery && <button type="button" className="button button--outline"
        onClick={() => setRefresh(value => value + 1)}>Retry price check</button>}
      {checked && checked.availability === "available" && limit > 0 && <>
        {personalization && <PersonalizationField settings={personalization} value={personalizationDraft} onChange={setPersonalizationDraft} />}
        {remaining > 0 && <QuantityControl value={chosenQuantity} max={remaining}
          onChange={value => setQuantity({ variantId: checked.id, value })} />}
        {remaining === 0 && <p className="product-detail__note">Your cart already contains the available quantity.</p>}
      </>}
      <div className="connected-product-purchase">
        {legacySelection ? <a href={`?${params}`} className="button button--primary">Continue with this variant</a>
          : <button type="button" className="button button--primary" aria-describedby={availabilityId} disabled={!readyToAdd} onClick={() => void add()}>
          {adding ? "Adding…" : "Add to cart"}
        </button>}
        {feedback?.key === completedKey && <p className={`add-feedback${feedback.ok ? "" : " add-feedback--error"}`} role="status">
          <span>{feedback.text}</span> <Link href="/cart">View cart</Link>
        </p>}
      </div>
      <ShareProductSelection market={market} variantId={selected?.id} picks={choice.issue || currentCheck?.unavailable ? undefined : choice.picks} />
      <Specifications data={data} selected={selected} locale={market.locale} />
      <div className="mp-panel-links"><Link href="/help/delivery">Delivery details</Link><Link href="/help/returns">Return policy</Link></div>
    </div>
  </div>;
}
