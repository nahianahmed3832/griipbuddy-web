"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useSyncExternalStore, useTransition, type FormEvent } from "react";
import { saveProductAction } from "@/app/staff/catalog-actions";
import { marketList } from "@/config/markets";
import { MAX_GALLERY_IMAGES, readMarketOffer, type ProductInput, type VariantInput } from "@/lib/staff/catalog-input";
import { postMerchandising } from "@/lib/staff/merchandising-client";
import { CatalogImageField } from "./catalog-image-field";
import { CatalogVideoField } from "./catalog-video-field";

type Choice = { id: string; name: string };
const subscribeToHydration = () => () => {};
const rowText = (rows: readonly { label: string; value: string }[] = []) => rows.map(({ label, value }) => `${label}: ${value}`).join("\n");
const asPairs = (text: string) => text.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
  const colon = line.indexOf(":");
  if (colon < 1 || !line.slice(colon + 1).trim()) throw new Error("Write each attribute or option on its own line as Name: value.");
  return { label: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() };
});

function VariantFields({ name, variant, remove }: { name: string; variant?: VariantInput; remove: () => void }) {
  return (
    <fieldset className="catalog-fields">
      <legend>{variant?.sku ?? "New variant"}</legend>
      <div className="commerce-fields">
        <label>SKU<input name={`${name}.sku`} defaultValue={variant?.sku} readOnly={Boolean(variant)} maxLength={60} required /></label>
        <label className="commerce-option"><input name={`${name}.active`} type="checkbox" defaultChecked={variant?.active ?? true} /> Active variant</label>
      </div>
      <div className="commerce-fields">
        <label>Manufacturer GTIN (UPC, EAN or ISBN)
          <input name={`${name}.gtin`} defaultValue={variant?.gtin ?? ""} inputMode="numeric" maxLength={28} />
        </label>
        <label>Manufacturer part number (MPN)
          <input name={`${name}.mpn`} defaultValue={variant?.mpn ?? ""} maxLength={70} />
        </label>
      </div>
      <label className="commerce-option">
        <input name={`${name}.identifiersNotAssigned`} type="checkbox" defaultChecked={variant?.identifiersNotAssigned ?? false} />
        No GTIN or manufacturer part number assigned
      </label>
      <label>Options, one Name: value per line
        <textarea name={`${name}.options`} defaultValue={rowText(Object.entries(variant?.options ?? {}).map(([label, value]) => ({ label, value })))} rows={2} maxLength={500} placeholder="Color: Oat" />
      </label>
      <div className="commerce-fields">
        {marketList.map((market) => {
          const offer = variant?.offers.find(({ marketId }) => marketId === market.id);
          return <div className="commerce-form" key={market.id}>
            <label>{market.name} price ({market.currency})
              <input name={`${name}.${market.id}.price`} inputMode="decimal" maxLength={10} defaultValue={offer ? (offer.amountMinor / 100).toFixed(2) : ""} />
            </label>
            <label className="commerce-option"><input type="checkbox" name={`${name}.${market.id}.eligible`} defaultChecked={offer?.eligible ?? false} /> Eligible in {market.name}</label>
          </div>;
        })}
      </div>
      <details open={variant?.image ? true : undefined}>
        <summary>Variant image</summary>
        <CatalogImageField name={`${name}.image`} src={variant?.image?.src} alt={variant?.image?.alt} />
      </details>
      <details open={variant?.videoUrl ? true : undefined}>
        <summary>Variant video</summary>
        <CatalogVideoField name={`${name}.videoUrl`} original={variant?.videoUrl} />
      </details>
      {!variant && <button className="link-button" type="button" onClick={remove}>Remove new variant</button>}
    </fieldset>
  );
}

export function ProductEditor({ existing, departments, collections, production, reviewDraft }: {
  existing: { product: ProductInput; revision: number } | null; departments: Choice[]; collections: Choice[]; production: boolean;
  reviewDraft?: { id: string; completeHref: string };
}) {
  const router = useRouter();
  const original = existing?.product;
  const nextRow = useRef(MAX_GALLERY_IMAGES + 1);
  const changedInputs = useRef(new Set<string>());
  const [images, setImages] = useState((original?.images ?? []).map((image, key) => ({ key, image: image as ProductInput["images"][number] | undefined })));
  const [variants, setVariants] = useState((original?.variants ?? []).map((variant, key) => ({ key, variant: variant as VariantInput | undefined })));
  const [revision, setRevision] = useState<number | null>(existing?.revision ?? null);
  const [message, setMessage] = useState<{ error?: string; success?: string }>({});
  const [pending, startTransition] = useTransition();
  const ready = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  const disabled = !ready || pending;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "");
    const image = (name: string) => ({ src: text(`${name}.src`), alt: text(`${name}.alt`) });
    const identifier = (name: string) => changedInputs.current.has(name) ? text(name).trim() || null : undefined;
    setMessage({});
    try {
      const product: ProductInput = {
        id: text("id"), slug: text("slug"), name: text("name"), brand: identifier("brand"), departmentId: text("departmentId"),
        description: text("description"), shortDescription: text("shortDescription") || undefined, specifications: asPairs(text("specifications")),
        keywords: text("keywords").split(",").map((word) => word.trim()).filter(Boolean),
        collectionIds: form.getAll("collectionIds").map(String),
          publication: reviewDraft ? "DRAFT" : text("publication") as ProductInput["publication"],
          demo: reviewDraft ? original?.demo ?? true : form.has("demo"),
        featured: form.has("featured"), newArrival: form.has("newArrival"),
        images: images.map(({ key }) => image(`image.${key}`)),
        videoUrl: text("videoUrl") || null,
        variants: variants.map(({ key }) => {
          const name = `variant.${key}`;
          const pairs = asPairs(text(`${name}.options`));
          if (pairs.length !== new Set(pairs.map(({ label }) => label)).size) throw new Error("Use each option name once per variant.");
          const photo = image(`${name}.image`);
          return {
            sku: text(`${name}.sku`), active: form.has(`${name}.active`),
            gtin: identifier(`${name}.gtin`), mpn: identifier(`${name}.mpn`),
            identifiersNotAssigned: changedInputs.current.has(`${name}.identifiersNotAssigned`) ? form.has(`${name}.identifiersNotAssigned`) : undefined,
            options: Object.fromEntries(pairs.map(({ label, value }) => [label, value])),
            ...(photo.src || photo.alt ? { image: photo } : {}),
            videoUrl: text(`${name}.videoUrl`) || null,
            offers: marketList.flatMap(({ id }) => readMarketOffer(id, form.get(`${name}.${id}.price`), form.has(`${name}.${id}.eligible`))),
          };
        }),
      };
      startTransition(async () => {
        try {
          if (reviewDraft && revision !== null) {
            const form = new FormData();
            form.set("operation", "edit");
            form.set("candidate", reviewDraft.id);
            form.set("revision", String(revision));
            form.set("product", JSON.stringify(product));
            const result = await postMerchandising(form);
            setMessage(result);
            if (!result.error) { router.replace(reviewDraft.completeHref); router.refresh(); }
            return;
          }
          const result = await saveProductAction(product, revision);
          setMessage(result);
          if (result.revision !== undefined) setRevision(result.revision);
          if (!original && result.success) router.replace(`/staff/catalog/products/${product.id.trim()}`);
        } catch {
          setMessage({ error: "The save request did not complete. Refresh the editor before retrying." });
        }
      });
    } catch (error) {
      setMessage({ error: error instanceof Error ? error.message : "Review the product fields." });
    }
  }

  return (
    <form className="catalog-editor commerce-form" method="post" onSubmit={submit} aria-busy={disabled}
      onChange={({ target }) => { if (target instanceof HTMLInputElement) changedInputs.current.add(target.name); }}>
      <fieldset className="commerce-panel commerce-form" disabled={disabled}>
        <legend>Product information</legend>
        <div className="commerce-fields">
          <label>Product name<input name="name" defaultValue={original?.name} minLength={2} maxLength={120} required /></label>
          <label>Stable product ID<input name="id" defaultValue={original?.id} readOnly={Boolean(original)} pattern="[a-z0-9][a-z0-9-]{0,79}" placeholder="brand-style-001" required /></label>
          <label>URL slug<input name="slug" defaultValue={original?.slug} pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={120} placeholder="example-product" required /></label>
          <label>Category<select name="departmentId" defaultValue={original?.departmentId ?? ""} required>
            <option value="" disabled>Choose a category</option>
            {departments.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select></label>
        </div>
        <label>Manufacturer brand
          <input name="brand" defaultValue={original?.brand ?? ""} maxLength={70} />
          <small>For accessories, enter the brand that made the product.</small>
        </label>
        <label>Short description<input name="shortDescription" defaultValue={original?.shortDescription} maxLength={240} /></label>
        <label>Description<textarea name="description" defaultValue={original?.description} rows={4} maxLength={4000} /></label>
        <label>Category attributes, one Name: value per line<textarea name="specifications" defaultValue={rowText(original?.specifications)} rows={3} maxLength={9100} placeholder="Material: Cotton" /></label>
        <label>Search keywords, separated by commas<input name="keywords" defaultValue={original?.keywords.join(", ")} maxLength={1250} /></label>
        {collections.length > 0 && <fieldset className="catalog-fields">
          <legend>Collections</legend>
          <div className="catalog-checkboxes">
            {collections.map(({ id, name }) => <label className="commerce-option" key={id}>
              <input type="checkbox" name="collectionIds" value={id} defaultChecked={original?.collectionIds.includes(id)} /> {name}
            </label>)}
          </div>
        </fieldset>}
        {!reviewDraft && <label>Publication<select name="publication" defaultValue={original?.publication ?? "DRAFT"}>
          <option value="DRAFT">Draft</option><option value="ACTIVE">Active</option><option value="ARCHIVED">Archived</option>
        </select></label>}
        <div className="catalog-checkboxes">
          {!production && !reviewDraft && <label className="commerce-option"><input type="checkbox" name="demo" defaultChecked={original?.demo ?? true} /> Staging sample</label>}
          <label className="commerce-option"><input type="checkbox" name="featured" defaultChecked={original?.featured} /> Featured</label>
          <label className="commerce-option"><input type="checkbox" name="newArrival" defaultChecked={original?.newArrival} /> New arrival</label>
        </div>
      </fieldset>
      <fieldset className="commerce-panel commerce-form" disabled={disabled}>
        <legend>Gallery</legend>
        <fieldset className="catalog-fields">
          <legend>Product video</legend>
          <CatalogVideoField name="videoUrl" original={original?.videoUrl} />
        </fieldset>
        {images.map(({ key, image }) => <div className="catalog-fields" key={key}>
          <CatalogImageField name={`image.${key}`} src={image?.src} alt={image?.alt} required />
          <button className="link-button" type="button" onClick={() => setImages((rows) => rows.filter((row) => row.key !== key))}>Remove gallery image</button>
        </div>)}
        <button className="button button--outline" type="button" disabled={images.length >= MAX_GALLERY_IMAGES} onClick={() => setImages([...images, { key: nextRow.current++, image: undefined }])}>Add gallery image</button>
      </fieldset>
      <fieldset className="commerce-panel commerce-form" disabled={disabled}>
        <legend>Variants and market offers</legend>
        <p>New SKUs start at zero stock. Inventory adjustments use the stock editor.</p>
        {variants.map(({ key, variant }) => <VariantFields key={key} name={`variant.${key}`} variant={variant} remove={() => setVariants((rows) => rows.filter((row) => row.key !== key))} />)}
        <button className="button button--outline" type="button" disabled={variants.length >= 40} onClick={() => setVariants([...variants, { key: nextRow.current++, variant: undefined }])}>Add variant</button>
      </fieldset>
      <div className="catalog-editor__actions">
        <button className="button button--primary" type="submit" disabled={disabled}>{pending ? "Saving…" : reviewDraft ? "Save proposed edits" : "Save product"}</button>
        {original && !reviewDraft && <Link className="button button--outline" href={`/staff/catalog/inventory?q=${original.id}`}>Adjust stock</Link>}
        {original?.publication === "ACTIVE" && !reviewDraft && <Link className="button button--outline" href={`/products/${original.slug}`}>View product</Link>}
        {message.error && <p className="commerce-message commerce-message--error" role="alert">{message.error}</p>}
        {message.success && <p className="commerce-message" role="status">{message.success}</p>}
      </div>
    </form>
  );
}
