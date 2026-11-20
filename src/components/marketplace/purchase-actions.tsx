"use client";

import { MarketplaceForm } from "./action-form";
import { MessageShop } from "./messages";
import { useMarketplace } from "./session";

export function ClaimOrder({ id }: { id: string }) {
  const state = useMarketplace()!;
  if (!state.shopper) return <button className="button button--outline" type="button" onClick={state.openAuth}>Sign in to save this order</button>;
  return <MarketplaceForm label="Save order to your account" success="Order saved to your purchases." command={() => ({ action: "claim-order", order: id })}/>;
}

export function OrderHelp({ id, shops }: { id: string; shops: { id: string; name: string }[] }) {
  return <div className="mp-panel-links">{shops.map(shop => <MessageShop key={shop.id} shop={shop.id} shopName={shop.name} order={id}/>)}</div>;
}

export function ReviewPurchase({ id, item, saved }: { id: string; item: { productId: string; name: string }; saved?: { text: string; stars: number; visible: boolean } }) {
  return <details className="mp-section">
    <summary>{saved ? "Edit your review of" : "Review"} {item.name}</summary>
    {saved && !saved.visible && <p>Your review is waiting for moderation.</p>}
    <MarketplaceForm label="Submit review" success="Review submitted for moderation." fields={<>
      <label>Rating<select name="stars" defaultValue={saved?.stars ?? 5}>{[5, 4, 3, 2, 1].map(stars => <option key={stars} value={stars}>{stars} {stars === 1 ? "star" : "stars"}</option>)}</select></label>
      <label>Your review<textarea name="text" defaultValue={saved?.text ?? ""} rows={4} minLength={5} maxLength={1200} required/></label>
    </>} command={form => ({ action: "review", order: id, product: item.productId, stars: Number(form.get("stars")), text: form.get("text") })}/>
  </details>;
}
