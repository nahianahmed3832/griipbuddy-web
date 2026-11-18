"use client";

import { storefrontPath } from "@/config/storefront-path";
import { marketList, markets, type MarketId } from "@/config/markets";
import type { MarketGrantStatus } from "@/lib/marketplace/market-grants";
import { MAX_PERSONALIZATION_PROMPT, type Personalization } from "@/lib/catalog/personalization";
import { videoUploadLimit } from "@/lib/catalog/video";
import { MarketplaceForm, useMarketplaceSubmission } from "./action-form";

type Shop = { name: string; about: string; announcement: string };
type Listing = {
  id: string; name: string; description: string; departmentId: string; tags: string; sku: string; amount: string; quantity: number;
  marketPrices?: Partial<Record<MarketId, string>>;
  personalization?: Personalization;
};
type Grant = { marketId: MarketId; status: MarketGrantStatus };
const grantLabels = { PENDING: "Pending review", APPROVED: "Approved", DENIED: "Unavailable" } as const;

export function ShopForm({ shop }: { shop?: Shop }) {
  return <MarketplaceForm label={shop ? "Save shop" : "Create your shop"} success={shop ? "Shop updated." : "Shop created."}
    fields={<>
      <label>Shop name<input name="name" defaultValue={shop?.name} minLength={3} maxLength={60} required/></label>
      {!shop && <label>Shop address<input name="slug" placeholder="your-shop-name" minLength={3} maxLength={60}
        pattern="[a-z0-9]+(-[a-z0-9]+)*" required/><small>Use lowercase letters, numbers and hyphens.</small></label>}
      {shop && <label>Announcement<input name="announcement" defaultValue={shop.announcement} maxLength={200}/></label>}
      <label>About your shop<textarea name="about" defaultValue={shop?.about} rows={4} minLength={10} maxLength={1600} required/></label>
    </>} command={form => ({ action: shop ? "edit-shop" : "create-shop", name: form.get("name"), about: form.get("about"),
      ...(shop ? { announcement: form.get("announcement") } : { slug: form.get("slug") }) })}/>;
}

export function ListingForm({ departments, listing, marketIds }: {
  departments: readonly { id: string; name: string }[]; listing?: Listing; marketIds?: readonly MarketId[];
}) {
  return <MarketplaceForm<{ id: string }> label={listing ? "Save changes" : "Create draft listing"} success="Draft saved."
    navigate={listing ? undefined : result => `/seller/listings/${result.id}`}
    fields={<>
      <label>Listing title<input name="name" defaultValue={listing?.name} minLength={3} maxLength={120} required/></label>
      <label>Description<textarea name="description" defaultValue={listing?.description} rows={5} minLength={10} maxLength={2200} required/></label>
      <label>Category<select name="department" defaultValue={listing?.departmentId ?? ""} required>
        <option value="">Choose a category</option>{departments.map(department => <option key={department.id} value={department.id}>{department.name}</option>)}
      </select></label>
      <label>Tags<input name="tags" defaultValue={listing?.tags} placeholder="Comma-separated tags" maxLength={300}/></label>
      <label>SKU<input name="sku" defaultValue={listing?.sku} minLength={2} maxLength={47} pattern="[A-Za-z0-9][A-Za-z0-9\\-]*" required/></label>
      <div className="commerce-fields">
        {marketIds ? marketIds.map(marketId => <label key={marketId}>{markets[marketId].name} price ({markets[marketId].currency})
          <input name={`amount-${marketId}`} type="number" defaultValue={listing?.marketPrices?.[marketId]}
            min="1" max="100000" step=".01" placeholder="Leave blank to omit"/>
        </label>) : <label>Price in BDT<input name="amount" type="number" defaultValue={listing?.amount} min="1" max="100000" step=".01" required/></label>}
        <label>Stock quantity<input name="quantity" type="number" defaultValue={listing?.quantity ?? 1} min="0" max="1000" required/></label>
      </div>
      <fieldset className="commerce-form">
        <legend>Personalization</legend>
        <label>Instructions for buyers<input name="personalizationPrompt" maxLength={MAX_PERSONALIZATION_PROMPT}
          placeholder="Example: Enter the name to engrave" defaultValue={listing?.personalization?.prompt}/></label>
        <small>Leave the instructions blank to turn personalization off.</small>
        <label className="commerce-option"><input type="checkbox" name="personalizationRequired"
          defaultChecked={listing?.personalization?.required}/> Require personalization</label>
      </fieldset>
    </>} command={form => {
      const prompt = String(form.get("personalizationPrompt") ?? "").trim();
      return {
        action: "draft-listing", id: listing?.id, name: form.get("name"), description: form.get("description"),
        department: form.get("department"), tags: form.get("tags"), sku: form.get("sku"),
        ...(marketIds ? { marketPrices: Object.fromEntries(marketIds.flatMap(marketId => {
          const value = form.get(`amount-${marketId}`);
          return value ? [[marketId, Math.round(Number(value) * 100)]] : [];
        })) } : { amount: Math.round(Number(form.get("amount")) * 100) }), quantity: Number(form.get("quantity")),
        personalization: prompt ? { prompt, required: form.has("personalizationRequired") } : null,
      };
    }}/>;
}

export function ListingPhotoForm({ product }: { product: string }) {
  const save = useMarketplaceSubmission();
  return <form className="mp-form" onSubmit={async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (await save.submit(async () => {
      const image = data.get("photo");
      if (!(image instanceof File) || !image.size || image.size > 4 * 1024 * 1024) throw new Error("Choose a photo up to 4 MB.");
      const query = new URLSearchParams({ product, alt: String(data.get("alt") ?? "") });
      const response = await fetch(storefrontPath(`/api/marketplace/listing-photo?${query}`),
        { method: "POST", headers: { "Content-Type": image.type }, body: image });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message ?? "Couldn't upload the photo.");
    }, "Photo added.")) form.reset();
  }}>
    <label>Listing photo<input type="file" name="photo" accept="image/jpeg,image/png,image/webp" required/></label>
    <label>Photo description<input name="alt" maxLength={180} required/></label>
    <button className="button button--primary" disabled={save.pending}>Upload photo</button>{save.feedback}
  </form>;
}

export function ListingVideoForm({ product, variant, label, src }: {
  product: string; variant?: string; label: string; src: string | null;
}) {
  const save = useMarketplaceSubmission();

  async function changeVideo(action: "upload" | "remove", file?: FormDataEntryValue | null) {
    const query = new URLSearchParams({ product, action, ...(variant && { variant }) });
    return save.submit(async () => {
      const video = file instanceof File ? file : undefined;
      if (action === "upload" && (!video?.size || video.size > videoUploadLimit)) throw new Error("Choose an MP4 video up to 4 MB.");
      const response = await fetch(storefrontPath(`/api/marketplace/listing-video?${query}`), {
        method: "POST", headers: video ? { "Content-Type": video.type } : undefined, body: video,
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message ?? "The video could not be saved.");
    }, action === "upload" ? "Video saved." : "Video removed.");
  }

  return <form className="mp-form" onSubmit={async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (await changeVideo("upload", new FormData(form).get("video"))) form.reset();
  }}>
    {src && <video src={storefrontPath(src)} controls playsInline preload="none" width={240} aria-label={label} />}
    <label>{label}<input type="file" accept="video/mp4,.mp4" name="video" required disabled={save.pending} /></label>
    <button className="button button--primary" disabled={save.pending}>{src ? "Replace video" : "Upload video"}</button>
    {src && <button type="button" className="button button--outline" disabled={save.pending} onClick={() => void changeVideo("remove")}>Remove video</button>}
    {save.feedback}
  </form>;
}

export function ShopModeration({ shop, published }: { shop: string; published: boolean }) {
  return <MarketplaceForm label={published ? "Hide shop" : "Approve shop"} success={published ? "Shop hidden." : "Shop approved."}
    command={() => ({ action: "staff-shop", shop, published: !published })}/>;
}

export function SellerMarkets({ grants }: { grants: readonly Grant[] }) {
  return <ul className="mp-shop-grid">{marketList.map(market => {
    const grant = grants.find(item => item.marketId === market.id);
    return <li key={market.id} className="mp-list-card">
      <strong>{market.name} ({market.currency})</strong><p>{grant ? grantLabels[grant.status] : "Application available"}</p>
      {(!grant || grant.status === "DENIED") && <MarketplaceForm label={`Apply to sell in ${market.name}`}
        success="Market application submitted." command={() => ({ action: "request-market", marketId: market.id })}/>}
    </li>;
  })}</ul>;
}

export function MarketModeration({ shop, grants }: { shop: string; grants: readonly Grant[] }) {
  return <ul className="mp-editor-list">{marketList.map(market => {
    const grant = grants.find(item => item.marketId === market.id);
    const approved = grant?.status === "APPROVED";
    return <li key={market.id}>
      <strong>{market.name}</strong><p>{grant ? grantLabels[grant.status] : "No application"}</p>
      <MarketplaceForm label={approved ? `Revoke ${market.name} access` : `Approve ${market.name} access`}
        success={approved ? "Market access revoked." : "Market access approved."}
        command={() => ({ action: "staff-market-grant", shop, marketId: market.id, status: approved ? "DENIED" : "APPROVED" })}/>
      {grant?.status === "PENDING" && <MarketplaceForm label={`Decline ${market.name} application`} success="Market application declined."
        command={() => ({ action: "staff-market-grant", shop, marketId: market.id, status: "DENIED" })}/>}
    </li>;
  })}</ul>;
}

export function ReviewModeration({ review, visible }: { review: string; visible: boolean }) {
  return <MarketplaceForm label={visible ? "Hide review" : "Restore review"} success={visible ? "Review hidden." : "Review restored."}
    command={() => ({ action: "staff-review", review, visible: !visible })}/>;
}
