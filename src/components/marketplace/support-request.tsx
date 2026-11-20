"use client";

import { useRef } from "react";
import { MarketplaceForm } from "./action-form";
import { storeShop } from "@/lib/marketplace/constants";

export function StartSupportRequest() {
  const dialog = useRef<HTMLDialogElement>(null);
  return <>
    <p>Send a message and check replies here. For a return or cancellation, open the original order.</p>
    <button className="button button--outline" type="button" onClick={() => dialog.current?.showModal()}>Start a support request</button>
    <dialog ref={dialog} className="store-dialog" aria-label="Start a support request">
      <h2>Start a support request</h2>
      <MarketplaceForm<{ id: string }> label="Send support request" success="Your request was saved." retryable reset
        navigate={result => {
          dialog.current?.close();
          return `/messages/${result.id}`;
        }}
        fields={<>
          <label>Subject<input name="subject" minLength={2} maxLength={100} required/></label>
          <label>Message<textarea name="text" rows={4} minLength={2} maxLength={1600} required/></label>
        </>}
        command={form => ({ action: "open-message", shop: storeShop.id, subject: form.get("subject"), text: form.get("text") })}/>
      <button className="button button--outline" type="button" onClick={() => dialog.current?.close()}>Close</button>
    </dialog>
  </>;
}
