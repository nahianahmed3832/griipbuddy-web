"use client";

import { X } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { setDemoAccount } from "@/app/actions";
import { demoAccount, store } from "@/config/store";

export function SignIn({ signedIn }: { signedIn: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [staySignedIn, setStaySignedIn] = useState(true);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  function updateAccount() {
    if (pending) return;
    setError(false);
    startTransition(async () => {
      try {
        await setDemoAccount(!signedIn, staySignedIn);
        dialog.current?.close();
      } catch {
        setError(true);
      }
    });
  }

  return (
    <div className="account-control">
      <button
        className="account-control__trigger"
        ref={trigger}
        type="button"
        aria-label={signedIn ? "Demo account" : undefined}
        aria-haspopup="dialog"
        aria-controls="account-dialog"
        onClick={() => {
          setError(false);
          setStaySignedIn(true);
          dialog.current?.showModal();
        }}
      >
        {signedIn ? "Account" : "Sign in"}
      </button>
      <dialog
        id="account-dialog"
        className="store-dialog account-dialog"
        ref={dialog}
        aria-labelledby="account-dialog-title"
        onClose={() => trigger.current?.focus()}
        onCancel={(event) => { if (pending) event.preventDefault(); }}
      >
        <button
          className="store-dialog__close"
          type="button"
          aria-label="Close"
          disabled={pending}
          onClick={() => dialog.current?.close()}
        >
          <X aria-hidden="true" size={20} />
        </button>
        <div className="account-dialog__title">
          <p className="wordmark" aria-hidden="true">{store.name}</p>
          <h2 id="account-dialog-title" className="display-type">{signedIn ? "Demo account" : "Sign in"}</h2>
          <p className="store-dialog__description">
            {signedIn ? "You’re signed in to the storefront preview." : "Try signing in with the demo account."}
          </p>
        </div>
        <form
          className="store-dialog__fields"
          onSubmit={(event) => {
            event.preventDefault();
            updateAccount();
          }}
        >
          <label className="store-dialog__field">
            Demo email address
            <input type="email" value={demoAccount.email} autoComplete="off" readOnly />
          </label>
          {!signedIn && (
            <label className="account-dialog__remember">
              <input type="checkbox" checked={staySignedIn} disabled={pending} onChange={(event) => setStaySignedIn(event.target.checked)} />
              Stay signed in
            </label>
          )}
          {error && <p className="store-dialog__error" role="alert">Couldn’t update the demo account. Please try again.</p>}
          <button className="button button--primary" type="submit" disabled={pending}>
            {signedIn ? (pending ? "Signing out…" : "Sign out") : (pending ? "Signing in…" : "Sign in with demo account")}
          </button>
          {!signedIn && (
            <>
              <span className="account-dialog__divider">or</span>
              <button className="button button--outline" type="button" disabled={pending} onClick={() => dialog.current?.close()}>
                Continue as guest
              </button>
            </>
          )}
        </form>
      </dialog>
    </div>
  );
}
