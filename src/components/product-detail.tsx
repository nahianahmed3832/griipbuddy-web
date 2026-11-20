"use client";

import { ArrowLeft, ArrowRight, Check, CircleCheck, CircleX, ShoppingBag, Store, Truck, X, ZoomIn } from "lucide-react";
import Image from "next/image";
import { storefrontPath } from "@/config/storefront-path";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useRef, useState } from "react";
import { formatMoney, type Market } from "@/config/markets";
import { useCart, useCartActions } from "@/lib/cart/browser";
import { useProductMeasurement } from "@/lib/measurement/browser";
import { rememberBuyPersonalization } from "@/lib/cart/buy-personalization";
import { MAX_QUANTITY, variantQuantities } from "@/lib/cart/model";
import type { CatalogImage, CatalogProduct, ListedVariant } from "@/lib/catalog/types";
import { variantLabel } from "@/lib/catalog/types";
import { merchantVariantDetails } from "@/lib/catalog/merchant-fields";
import { catalogSearchKey } from "@/lib/catalog/search-match";
import { personalizationAvailable, personalizationText } from "@/lib/catalog/personalization";
import { QuantityControl } from "./quantity-control";
import { AddToList, FavoriteButton } from "./marketplace/favorites";
import { PersonalizationField } from "./personalization-field";
import { ProductAddOns, RetailOptions, type ProductAddOn } from "./retail-product";
import { ProductVariantAlerts } from "./marketplace/variant-watch";
import { ShareProductSelection } from "./share-product-selection";
import type { VariantWatchOptions } from "@/lib/marketplace/variant-watches";

const swatches: Record<string, string> = {
  Plum: "#692f51", Oat: "#ded0b9", Sage: "#8d9476", Charcoal: "#3f3b3d", Cream: "#f1e3c8",
  Lilac: "#b79bc1", Taupe: "#a18a75", Caramel: "#ad7034", Clay: "#c28573", Amber: "#cc8e43",
  Butter: "#ecca74", Terracotta: "#bd7255", Mauve: "#b78d9f", Natural: "#d5ac78", Olive: "#737951", Mustard: "#c19531",
};

function chooseVariant(variants: readonly ListedVariant[], current: ListedVariant, name: string, value: string, hasModel: boolean) {
  const others = Object.entries(current.options).filter(([key]) => key !== name);
  const matching = variants.filter((variant) => variant.options[name] === value);
  const exact = matching.find(variant => others.every(([key, option]) => variant.options[key] === option) &&
    (!hasModel || Object.keys(variant.options).every(key => key === name || variant.options[key] === current.options[key])));
  if (exact || hasModel) return exact;
  return matching.find((variant) => (variant.offer?.stock ?? 0) > 0)
    ?? matching[0];
}

function uniquePhotos(product: CatalogProduct, selected: ListedVariant): CatalogImage[] {
  const photos = [
    ...(selected.image ? [selected.image] : []),
    ...product.images,
    ...product.variants.flatMap((variant) => variant.image ? [variant.image] : []),
  ];
  const seen = new Set<string>();
  return photos.filter(photo => {
    if (seen.has(photo.src)) return false;
    seen.add(photo.src);
    return true;
  });
}

export function ProductDetail({ product, market, initialVariantId, departmentName, preview, firstParty, models = [], hybrid, sales = 0, addOns = [], watches, checkoutEnabled = false }: {
  product: CatalogProduct;
  market: Market;
  initialVariantId?: string;
  departmentName: string;
  preview?: boolean;
  checkoutEnabled?: boolean;
  firstParty?: boolean;
  models?: readonly { id: string; name: string }[];
  hybrid?: boolean;
  sales?: number;
  addOns?: readonly ProductAddOn[];
  watches?: { shopperId?: string; options: readonly (VariantWatchOptions & { variantId: string })[] };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const defaultVariant = product.variants.find((variant) => variant.id === initialVariantId)
    ?? product.variants.find((variant) => (variant.offer?.stock ?? 0) > 0)
    ?? product.variants.find((variant) => variant.offer)
    ?? product.variants[0];
  const [previewVariantId, setPreviewVariantId] = useState(defaultVariant.id);
  const selectedId = preview ? previewVariantId : searchParams.get("variant");
  const selected = product.variants.find((variant) => variant.id === selectedId) ?? defaultVariant;
  const [uiVariantId, setUiVariantId] = useState(selected.id);
  const [quantity, setQuantity] = useState(1);
  const [personalizationDraft, setPersonalizationDraft] = useState("");
  const [photoChoice, setPhotoChoice] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string; marketId: string; variantId: string } | null>(null);
  const [configurationSearch, setConfigurationSearch] = useState("");
  const zoom = useRef<HTMLDialogElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const optionId = useId();
  const { items, ready, sync } = useCart();
  const { addToCart } = useCartActions();
  if (uiVariantId !== selected.id) {
    setUiVariantId(selected.id);
    setPhotoChoice(null);
    setQuantity(1);
    setFeedback(null);
  }
  const photos = uniquePhotos(product, selected);
  const photo = photos.find(({ src }) => src === photoChoice) ?? photos[0];
  const optionNames = [...new Set(product.variants.flatMap((variant) => Object.keys(variant.options)))];
  const modelOption = optionNames.find(name => /model|device|handset/i.test(name));
  const configurationQuery = catalogSearchKey(configurationSearch);
  const configurations = modelOption ? product.variants.filter(variant => variant === selected ||
    catalogSearchKey(variant.options[modelOption] ?? "").includes(configurationQuery)) : [];
  const guides = hybrid ? product.specifications.filter(spec => /^Size guide\s*[:–-]/i.test(spec.label)) : [];
  const { brand, gtin, mpn } = merchantVariantDetails(product, selected);
  const identifiers = [{ label: "Brand", value: brand }, { label: "GTIN", value: gtin }, { label: "MPN", value: mpn }]
    .flatMap(({ label, value }) => value ? [{ label, value }] : []);
  const specifications = [...identifiers, ...product.specifications.flatMap(spec => {
    if (guides.includes(spec)) return [];
    const label = spec.label.trim().toLowerCase();
    // In the imported catalog, the Brand specification identifies the compatible device.
    if (label === "brand") return spec.value.trim() === brand ? [] : [{ ...spec, label: "Compatibility brand" }];
    return identifiers.some(identifier => identifier.label.toLowerCase() === label) ? [] : [spec];
  })];
  const marketOffer = selected.offer;
  useProductMeasurement(product.id, selected.id, market.id, marketOffer?.amountMinor, !preview);
  const max = Math.min(marketOffer?.stock ?? 0, MAX_QUANTITY);
  const inCart = variantQuantities(items).get(selected.id) ?? 0;
  const remaining = Math.max(0, max - inCart);
  const chosenQuantity = Math.max(1, Math.min(remaining, quantity));
  const available = max > 0;
  const activeFeedback = feedback?.marketId === market.id && feedback.variantId === selected.id ? feedback : null;
  const shop = preview ? undefined : product.shop;
  const settings = shop ? product.personalization : undefined;
  const note = settings ? personalizationText(personalizationDraft) : undefined;
  const validPersonalization = (!settings || !personalizationDraft.trim() || Boolean(note)) &&
    personalizationAvailable(settings, note);
  const buyHref = `/checkout?buy=${encodeURIComponent(selected.id)}&quantity=${Math.min(quantity, max)}`;
  const currentPhoto = photos.findIndex(item => item.src === photo?.src);
  const movePhoto = (direction: number) => setPhotoChoice(photos[(currentPhoto + photos.length + direction) % photos.length]?.src ?? null);

  function selectVariant(nextId: string) {
    if (nextId === selected.id || !product.variants.some(variant => variant.id === nextId)) return;
    if (preview) {
      setPreviewVariantId(nextId);
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("option");
    url.searchParams.set("variant", nextId);
    window.history.pushState(null, "", url);
  }

  const choiceFor = (name: string, value: string) => chooseVariant(product.variants, selected, name, value, Boolean(modelOption) && !preview);
  function selectOption(name: string, value: string) {
    const next = choiceFor(name, value);
    if (next) selectVariant(next.id);
  }

  const configurationPicker = !preview && modelOption && product.variants.length > 1 && <fieldset className="connected-option-group">
    <legend>Compatible configurations</legend>
    <label className="store-dialog__field">Search model options
      <input type="search" value={configurationSearch} onChange={event => setConfigurationSearch(event.target.value)} />
    </label>
    <label className="store-dialog__field">Choose a configuration
      <select value={selected.id} onChange={event => selectVariant(event.target.value)}>
        {configurations.map(variant => <option key={variant.id} value={variant.id}>
          {variantLabel(variant)}{variant.sku ? ` · ${variant.sku}` : ""}
        </option>)}
      </select>
    </label>
    {!!configurationQuery && !configurations.some(variant => catalogSearchKey(variant.options[modelOption] ?? "").includes(configurationQuery)) &&
      <p className="product-detail__note" role="status">No matching models.</p>}
  </fieldset>;

  async function add() {
    if (preview || !ready || sync === "saving" || !available || remaining < 1 || !validPersonalization) return;
    const added = await addToCart(selected.id, chosenQuantity, max, note,
      { productId: product.id, priceMinor: marketOffer?.amountMinor, placement: "product-detail" });
    setFeedback({
      ok: added, marketId: market.id, variantId: selected.id,
      text: added ? `Added ${chosenQuantity} to your cart.` : "Your cart couldn’t be updated. Review your cart and try again.",
    });
  }

  if (shop && photo) return <div className="mp-listing-detail">
    <section className="product-gallery" aria-label="Product images">
      <button type="button" className="product-gallery__main" aria-label="Zoom product image" onClick={() => zoom.current?.showModal()}
        onTouchStart={event => {
          const touch = event.touches[0];
          if ((firstParty || hybrid) && photos.length > 1 && event.touches.length === 1 && touch) {
            touchStart.current = { x: touch.clientX, y: touch.clientY };
          }
        }}
        onTouchEnd={event => {
          const start = touchStart.current;
          touchStart.current = null;
          const touch = event.changedTouches[0];
          if (!start || !touch) return;
          const delta = touch.clientX - start.x;
          if (Math.abs(delta) > 45 && Math.abs(delta) > Math.abs(touch.clientY - start.y) * 1.5) movePhoto(delta < 0 ? 1 : -1);
        }}
        onTouchCancel={() => { touchStart.current = null; }}>
        <Image src={storefrontPath(photo.src)} alt={photo.alt} fill loading="eager" sizes="(max-width: 730px) 100vw, 63vw"/>
        <span className="mp-gallery-zoom-icon"><ZoomIn size={21}/></span>
      </button>
      {photos.length > 1 && <div className="product-gallery__thumbs" aria-label="Choose product image">{photos.map((image, index) =>
        <button key={image.src} type="button" aria-label={`View image ${index + 1}`} aria-pressed={image.src === photo.src} onClick={() => setPhotoChoice(image.src)}>
          <Image src={storefrontPath(image.src)} alt="" fill sizes="60px"/>
        </button>
      )}</div>}
      <FavoriteButton product={product.id} name={product.name} market={market} variantId={selected.id} priceMinor={marketOffer?.amountMinor}/>
      <dialog className="store-dialog mp-image-zoom" ref={zoom} aria-label="Product image viewer" onKeyDown={event => {
        if (event.key === "ArrowLeft") movePhoto(-1);
        if (event.key === "ArrowRight") movePhoto(1);
      }}>
        <button className="store-dialog__close" type="button" aria-label="Close image viewer" onClick={() => zoom.current?.close()}><X size={22}/></button>
        <div className="mp-zoom-frame"><Image src={storefrontPath(photo.src)} alt={photo.alt} fill sizes="90vw"/></div>
        {photos.length > 1 && <div className="mp-gallery-controls">
          <button type="button" className="mp-icon" aria-label="Previous image" onClick={() => movePhoto(-1)}><ArrowLeft size={19}/></button>
          <span aria-live="polite">{currentPhoto + 1} / {photos.length}</span>
          <button type="button" className="mp-icon" aria-label="Next image" onClick={() => movePhoto(1)}><ArrowRight size={19}/></button>
        </div>}
      </dialog>
    </section>
    <div className="mp-listing-info">
      {marketOffer && <p className="product-detail__price" aria-live="polite">{formatMoney(marketOffer.amountMinor, market)}
        {marketOffer.regularMinor && marketOffer.regularMinor > marketOffer.amountMinor ? <del>{formatMoney(marketOffer.regularMinor, market)}</del> : null}
      </p>}
      <h1>{product.name}</h1>
      {firstParty ? <p className="mp-shop-label"><Store size={17} aria-hidden="true"/> Sold by GriipBuddy</p>
        : <Link className="mp-shop-label" href={`/shops/${shop.slug}`}><Store size={17} aria-hidden="true"/> {hybrid && "Sold by "}{shop.name}</Link>}
      {hybrid && sales > 0 && <p className="retail-sales">{new Intl.NumberFormat(market.locale).format(sales)} sold in {market.name}</p>}
      {models.length > 0 && <div className="mp-panel-links">
        {models.map(model => <Link key={model.id} href={`/shop?device=${model.id}`}>{model.name} accessories</Link>)}
      </div>}
      <p className={`availability ${available ? "availability--yes" : "availability--no"}`} aria-live="polite">
        {available ? <CircleCheck size={15}/> : <CircleX size={15}/>}{available ? "In stock" : marketOffer ? "Out of stock" : `Unavailable in ${market.name}`}
      </p>
      {hybrid && available && max <= 3 && <p className="retail-scarcity">Only {marketOffer!.stock} left in this option</p>}
      {configurationPicker}
      {hybrid ? <RetailOptions names={optionNames} variants={product.variants} selected={selected} guides={guides} onSelect={selectOption}
        canSelect={(name, value) => Boolean(choiceFor(name, value))}/>
      : <div className="product-options">
        {optionNames.map(name => <label className="store-dialog__field" key={name}>{name}<select value={selected.options[name] ?? ""} onChange={event => selectOption(name, event.target.value)}>
          {!selected.options[name] && <option value="">Choose an option</option>}
          {[...new Set(product.variants.flatMap(variant => variant.options[name] ? [variant.options[name]] : []))].map(value =>
            <option key={value} disabled={!choiceFor(name, value)}>{value}</option>)}
        </select></label>)}
      </div>}
      {settings && available && <PersonalizationField settings={settings} value={personalizationDraft} onChange={setPersonalizationDraft}/>}
      {available && <QuantityControl value={quantity} max={max} onChange={setQuantity}/>}
      <div className="mp-listing-ctas">
        {available && checkoutEnabled && (settings
          ? <button type="button" className="button button--outline" disabled={!validPersonalization} onClick={() => {
            const intent = note ? rememberBuyPersonalization(selected.id, note) : undefined;
            router.push(intent ? `${buyHref}&custom=${intent}` : buyHref);
          }}>Buy it now</button>
          : <Link className="button button--outline" href={buyHref}>Buy it now</Link>)}
        <button type="button" className="button button--primary" disabled={!ready || sync === "saving" || !available || remaining < quantity || !validPersonalization} onClick={add}>
          {available ? remaining >= quantity ? "Add to cart" : "Quantity limit reached" : marketOffer ? "Out of stock" : "Unavailable in this market"}
        </button>
        <AddToList product={product.id} market={market} variantId={selected.id} priceMinor={marketOffer?.amountMinor}/>
      </div>
      {marketOffer && <ShareProductSelection market={market} variantId={selected.id} />}
      {watches && marketOffer && <ProductVariantAlerts key={`${market.id}/${selected.id}`} variantId={selected.id}
        variantLabel={variantLabel(selected)} marketId={market.id} shopperId={watches.shopperId}
        options={watches.options.find(watch => watch.variantId === selected.id)} />}
      {activeFeedback && <p className={`add-feedback ${activeFeedback.ok ? "" : "add-feedback--error"}`} role="status">
        <span>{activeFeedback.text}</span> <Link href="/cart">View cart</Link>
      </p>}
      {hybrid && <ProductAddOns entries={addOns} market={market} />}
      {firstParty && <div className="mp-panel-links">
        <Link href="/help/delivery"><Truck size={16} aria-hidden="true"/> Delivery by address</Link>
        <Link href="/help/returns">Returns</Link>
      </div>}
      <details open><summary>Item details</summary><p>{product.description}</p>
        {specifications.length > 0 && <dl className="specifications">{specifications.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
      </details>
      {!firstParty && <details><summary>Shipping and return policies</summary><p>{checkoutEnabled ? "Delivery and payment options are shown at checkout." : `Checkout is currently unavailable in ${market.name}.`}</p>
        <div className="mp-panel-links"><Link href="/help/delivery">Delivery details</Link><Link href="/help/returns">Return policy</Link></div>
      </details>}
    </div>
  </div>;

  return (
    <div className="product-detail">
      <section className="product-gallery" aria-label="Product images">
        <div className="product-gallery__main">
          <Image key={photo.src} src={storefrontPath(photo.src)} alt={photo.alt} fill loading="eager" sizes="(max-width: 759px) 100vw, 580px" />
        </div>
        {photos.length > 1 && (
          <div className="product-gallery__thumbs" role="group" aria-label="Choose product image">
            {photos.map((image, index) => (
              <button
                key={image.src}
                type="button"
                aria-label={`View image ${index + 1}: ${image.alt}`}
                aria-pressed={image.src === photo.src}
                onClick={() => setPhotoChoice(image.src)}
              >
                <Image src={storefrontPath(image.src)} alt="" fill sizes="76px" />
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="product-detail__info">
        <p className="eyebrow">{departmentName}</p>
        <h1 className="display-type">{product.name}</h1>
        {product.demo && <p className="commerce-muted">Staging sample product</p>}
        <div className="product-detail__pricing" aria-live="polite">
          {marketOffer && <p className="product-detail__price">{formatMoney(marketOffer.amountMinor, market)} <small>{market.currency}</small></p>}
          <p className={`availability ${available ? "availability--yes" : "availability--no"}`}>
            {available ? <CircleCheck aria-hidden="true" size={16} /> : <CircleX aria-hidden="true" size={16} />}
            {available ? "In stock" : marketOffer ? "Out of stock" : `Unavailable in ${market.name}`}
          </p>
        </div>
        <p className="product-detail__description">{product.description}</p>

        {configurationPicker}
        <div className="product-options">
          {optionNames.map((name) => {
            const values = [...new Set(product.variants.flatMap((variant) => variant.options[name] ? [variant.options[name]] : []))];
            if (values.length === 1) return <p key={name} className="single-option"><strong>{name}:</strong> {values[0]}</p>;
            return (
              <fieldset key={name} className="option-group">
                <legend>{name}<span> / {selected.options[name]}</span></legend>
                <div className="option-group__choices">
                  {values.map((value) => {
                    const variant = choiceFor(name, value);
                    const isUnavailable = !variant?.offer || variant.offer.stock === 0;
                    return (
                      <label className="variant-option" key={value} data-unavailable={isUnavailable || undefined}>
                        <input className="sr-only" type="radio" name={`${optionId}-${name}`} value={value} checked={selected.options[name] === value}
                          disabled={!variant} onChange={() => selectOption(name, value)} />
                        {name === "Color" && <span className="variant-option__swatch" style={{ backgroundColor: swatches[value] ?? "#d5cbc5" }} aria-hidden="true" />}
                        <span>{value}</span>
                        {isUnavailable && <span className="sr-only"> ({variant?.offer ? "out of stock" : "unavailable with current options"})</span>}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
        </div>
        {!preview && marketOffer && <ShareProductSelection market={market} variantId={selected.id} />}

        <div className="product-detail__actions">
          {available && remaining > 0 && !preview && <QuantityControl value={chosenQuantity} max={remaining} onChange={setQuantity} />}
          <button type="button" className="button button--primary add-button" disabled={preview || !ready || sync === "saving" || !available || remaining < 1} onClick={add}>
            <ShoppingBag aria-hidden="true" size={19} />
            {preview ? "Preview only" : available ? remaining ? "Add to cart" : "Quantity limit reached" : marketOffer ? "Out of stock" : "Unavailable in this market"}
          </button>
        </div>
        {available && remaining === 0 && <p className="product-detail__note">Your cart already holds the available quantity for this option.</p>}
        {activeFeedback && (
          <p className={`add-feedback ${activeFeedback.ok ? "" : "add-feedback--error"}`} role="status">
            {activeFeedback.ok && <Check aria-hidden="true" size={18} />}
            <span>{activeFeedback.text}</span> <Link href="/cart">View cart</Link>
          </p>
        )}

        <section className="specifications" aria-labelledby="specifications-heading">
          <h2 id="specifications-heading">Product details</h2>
          <dl>
            {specifications.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
        </section>
      </div>
    </div>
  );
}
