"use client";

import Link from "next/link";
import { useRef } from "react";
import { MessageCircle, X } from "lucide-react";
import { catalogBrowseHref } from "@/lib/catalog/catalog-browse-href";
import { MarketplaceForm } from "./action-form";
import { useMarketplace } from "./session";

export function MessageShop({ shop, shopName, order, product, productName, questionMarket }: {
  shop: string; shopName: string; order?: string; product?: string; productName?: string;
  questionMarket?: Parameters<typeof catalogBrowseHref>[1];
}) {
  const session = useMarketplace();
  const dialog = useRef<HTMLDialogElement>(null);
  if (!session) return null;
  return <>
    <button className="button button--outline" type="button" onClick={() => {
      if (session.shopper) dialog.current?.showModal(); else session.openAuth();
    }}><MessageCircle size={17}/> {order ? `Get help from ${shopName}` : product ? "Ask a product question" : "Message shop"}</button>
    <dialog ref={dialog} className="store-dialog mp-sign-in" aria-label={`Message ${shopName}`}>
      <button className="mp-dialog-close" type="button" aria-label="Close" onClick={() => dialog.current?.close()}><X size={18}/></button>
      <h2>{product ? "Ask a product question" : `Message ${shopName}`}</h2>
      <MarketplaceForm<{ id: string }> label={product ? "Send private question" : "Save message"}
        success={product ? "Question saved." : "Message saved."} retryable navigate={result => {
        dialog.current?.close();
        const path = `/messages/${result.id}`;
        return questionMarket ? catalogBrowseHref(path, questionMarket) : path;
      }} fields={<>
        <label>Subject<input name="subject" minLength={2} maxLength={100} required defaultValue={order ? "Help with my order" : productName ? productName.slice(0, 100) : undefined}/></label>
        <label>Message<textarea name="text" rows={4} minLength={2} maxLength={1600} required/></label>
      </>} command={form => ({ action: "open-message", shop, order, product, marketId: questionMarket?.id, subject: form.get("subject"), text: form.get("text") })} reset/>
    </dialog>
  </>;
}

export function ReplyForm({ thread }: { thread: string }) {
  return <MarketplaceForm label="Save reply" success="Reply saved." retryable fields={<label>Reply<textarea name="text" rows={3} minLength={2} maxLength={1600} required/></label>}
    command={form => ({ action: "reply", thread, text: form.get("text") })} reset/>;
}

export function CloseThread({ thread }: { thread: string }) {
  return <MarketplaceForm label="Close conversation" success="Conversation closed." retryable command={() => ({ action: "close-thread", thread })}/>;
}

export function ThreadLinks({ rows, prefix = "/messages", market }: { rows: {
  id: string; subject: string; shop: { name: string }; closed: boolean; order: { reference: string } | null; product?: { name: string } | null;
}[]; prefix?: string; market?: string }) {
  return rows.length ? <ul className="mp-shop-grid">{rows.map(row => <li key={row.id}><Link href={`${prefix}/${row.id}${market ? `?market=${market}` : ""}`}>
    <strong>{row.subject}</strong><p>{row.shop.name}{row.product && ` · ${row.product.name}`}{row.order && ` · ${row.order.reference}`}{row.closed && " · Closed"}</p>
  </Link></li>)}</ul> : <p>No conversations yet.</p>;
}
