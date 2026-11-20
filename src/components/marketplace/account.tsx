"use client";

import { useRef, useSyncExternalStore, type ReactNode } from "react";
import type { MarketId } from "@/config/markets";
import type { MarketConfiguration } from "@/lib/market-config";
import type { ShopperAddressKind } from "@/generated/prisma/enums";
import type { addressBook } from "@/lib/marketplace/address-book";
import styles from "./account-addresses.module.css";
import { MarketplaceForm, useMarketplaceSubmission } from "./action-form";
import { accountRequest } from "./session";

const subscribeToHydration = () => () => {};

export function ProfileForm({ name }: { name: string }) {
  const ready = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  const save = useMarketplaceSubmission();
  return <form className="mp-form" method="post" onSubmit={event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void save.submit(() => accountRequest("update-user", { name: form.get("name") }), "Name updated.");
  }}>
    <label>Display name<input name="name" defaultValue={name} minLength={2} maxLength={65} required autoComplete="name" disabled={!ready}/></label>
    <button className="button button--primary" disabled={!ready || save.pending}>Save profile</button>
    {!ready && <p role="status">Account controls are loading.</p>}{save.feedback}
    <noscript>Enable JavaScript to save profile changes.</noscript>
  </form>;
}

export function PasswordForm() {
  const ready = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  const save = useMarketplaceSubmission();
  return <form className="mp-form" method="post" onSubmit={async event => {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    if (await save.submit(() => accountRequest("change-password", { currentPassword: form.get("current"), newPassword: form.get("next"),
      revokeOtherSessions: true }), "Password changed. Other sessions have been signed out.")) element.reset();
  }}>
    <label>Current password<input name="current" type="password" autoComplete="current-password" maxLength={128} required disabled={!ready}/></label>
    <label>New password<input name="next" type="password" autoComplete="new-password" minLength={10} maxLength={128} required disabled={!ready}/></label>
    <button className="button button--primary" disabled={!ready || save.pending}>Change password</button>
    {!ready && <p role="status">Account controls are loading.</p>}{save.feedback}
    <noscript>Enable JavaScript to change your password.</noscript>
  </form>;
}


type Entry = Awaited<ReturnType<typeof addressBook>>[number];
type Districts = readonly { id: string; label: string }[];
type Market = Pick<MarketConfiguration, "id" | "countryCode" | "name" | "address">;

function AddressForm({ defaults, districts, address, market, kind }: {
  defaults: { name: string; email: string }; districts: Districts; address?: Entry; market: Market; kind: ShopperAddressKind;
}) {
  const details = address?.details;
  const postal = market.address.adapter === "us-postal";
  return <MarketplaceForm label={address ? "Save changes" : "Save address"} success="Address saved." reset={!address} retryable={!address} fields={<div className={styles.fields}>
    <label>Label<input name="label" placeholder="Home" defaultValue={address?.label} minLength={2} maxLength={60} required/></label>
    <label>Full name<input name="name" defaultValue={details?.name ?? defaults.name} autoComplete="name" minLength={2} maxLength={100} required/></label>
    <label>Phone number<input name="phone" type="tel" autoComplete="tel" defaultValue={details?.phone}
      placeholder={postal ? "(212) 555-0100" : "01XXXXXXXXX"} maxLength={28} required/></label>
    <label>Email (optional)<input name="email" type="email" defaultValue={details?.email ?? (details ? "" : defaults.email)} autoComplete="email" maxLength={254}/></label>
    {postal ? <label>State code<input name="district" defaultValue={details?.district.toUpperCase()} required
      autoComplete="address-level1" pattern="[A-Za-z]{2}" maxLength={2} placeholder="NY"/></label> :
      <label>District<select name="district" required defaultValue={details?.district ?? ""}>
        <option value="">Choose a district</option>{districts.map(zone => <option key={zone.id} value={zone.id}>{zone.label}</option>)}</select></label>}
    <label>{postal ? "City" : "Area or upazila"}<input name="locality" defaultValue={details?.locality} autoComplete="address-level2" minLength={2} maxLength={100} required/></label>
    <label className={styles.street}>Street address<input name="address" defaultValue={details?.address} autoComplete="street-address" minLength={5} maxLength={postal ? 120 : 240} required/></label>
    <label>{postal ? "ZIP code" : "Postal code (optional)"}<input name="postalCode" defaultValue={details?.postalCode ?? ""}
      autoComplete="postal-code" inputMode="numeric" required={postal}
      pattern={postal ? "[0-9]{5}(?:-[0-9]{4})?" : "[0-9]{4}"} maxLength={postal ? 10 : 4}/></label>
  </div>} command={form => ({ action: "save-address", label: form.get("label"), kind, marketId: market.id, address: address?.id, customer: {
    country: market.countryCode, ...Object.fromEntries(
      ["name", "phone", "email", "district", "locality", "address", "postalCode"].map(field => [field, form.get(field)]),
    ),
  } })}/>;
}

function RemoveAddress({ id, label, marketId, kind }: { id: string; label: string; marketId: MarketId; kind: ShopperAddressKind }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return <>
    <button type="button" className="button button--outline" onClick={() => dialog.current?.showModal()}>Remove</button>
    <dialog ref={dialog} className="store-dialog" aria-label={`Remove ${label} address`}>
      <h3>Remove {label}?</h3>
      <p>The address will be removed from your saved addresses.</p>
      <MarketplaceForm label="Remove address" success="Address removed." command={() => ({ action: "delete-address", address: id, marketId, kind })}/>
      <button type="button" className="button button--outline" onClick={() => dialog.current?.close()}>Cancel</button>
    </dialog>
  </>;
}

export function AddressBook({ addresses, districts, market, name, email }: {
  addresses: readonly Entry[]; districts: Districts; market: Market; name: string; email: string;
}) {
  const canWrite = market.address.adapter === "us-postal" || districts.length > 0;
  const defaults = { name, email };
  return <div className={styles.groups}>
    {(["SHIPPING", "BILLING"] as const).map(kind => {
      const shipping = kind === "SHIPPING";
      const title = shipping ? "Shipping addresses" : "Billing addresses";
      const entries = addresses.filter(row => row.kind === kind);
      return <section key={kind} aria-label={title} className={styles.group}>
        <h3>{title}</h3>
        {shipping
          ? <p>Use a saved shipping address when checking out in {market.name}.</p>
          : <p>Keep invoice contacts separately. Your payment provider may ask for billing details at payment.</p>}
        {entries.length ? <ul className={styles.addresses}>{entries.map(row => <li key={row.id} className={styles.address}>
          <div className={styles.addressTitle}><strong>{row.label}</strong>{row.isDefault && <span>Default</span>}</div>
          {row.details ? <address>
            <strong>{row.details.name}</strong><br/>{row.details.address}<br/>
            {row.details.locality}, {districts.find(option => option.id === row.details?.district)?.label ?? row.details.district.toUpperCase()}
            {row.details.postalCode && ` ${row.details.postalCode}`}
          </address> : <p>Check this address before using it at checkout.</p>}
          <div className={styles.actions}>
            {row.details && !row.isDefault && <MarketplaceForm label="Set as default" success="Default address saved."
              command={() => ({ action: "default-address", address: row.id, marketId: market.id, kind })}/>}
            <RemoveAddress id={row.id} label={row.label} marketId={market.id} kind={kind}/>
          </div>
          {canWrite && <Collapsible label="Edit address">
            <AddressForm key={JSON.stringify(row.details) + row.label} defaults={defaults} districts={districts} market={market} kind={kind} address={row}/>
          </Collapsible>}
        </li>)}</ul> : <p>No {shipping ? "shipping" : "billing"} addresses saved in {market.name}.</p>}
        {canWrite && <Collapsible label={shipping ? "Add shipping address" : "Add billing address"}>
          <AddressForm defaults={defaults} districts={districts} market={market} kind={kind}/>
        </Collapsible>}
        {!canWrite && <p>Address editing is unavailable until a district is configured for this market.</p>}
      </section>;
    })}
  </div>;
}

function Collapsible({ label, children }: { label: string; children: ReactNode }) {
  return <details className={styles.editor}><summary>{label}</summary>{children}</details>;
}
