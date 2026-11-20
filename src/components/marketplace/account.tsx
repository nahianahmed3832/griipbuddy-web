"use client";

import { MarketplaceForm, useMarketplaceSubmission } from "./action-form";
import { accountRequest } from "./session";

export function ProfileForm({ name }: { name: string }) {
  const save = useMarketplaceSubmission();
  return <form className="mp-form" onSubmit={event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void save.submit(() => accountRequest("update-user", { name: form.get("name") }), "Name updated.");
  }}>
    <label>Display name<input name="name" defaultValue={name} minLength={2} maxLength={65} required autoComplete="name"/></label>
    <button className="button button--primary" disabled={save.pending}>Save profile</button>{save.feedback}
  </form>;
}

export function PasswordForm() {
  const save = useMarketplaceSubmission();
  return <form className="mp-form" onSubmit={async event => {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    if (await save.submit(() => accountRequest("change-password", { currentPassword: form.get("current"), newPassword: form.get("next"),
      revokeOtherSessions: true }), "Password changed. Other sessions have been signed out.")) element.reset();
  }}>
    <label>Current password<input name="current" type="password" autoComplete="current-password" maxLength={128} required/></label>
    <label>New password<input name="next" type="password" autoComplete="new-password" minLength={10} maxLength={128} required/></label>
    <button className="button button--primary" disabled={save.pending}>Change password</button>{save.feedback}
  </form>;
}

export function SaveAddressForm({ districts, name, email }: { districts: readonly { id: string; label: string }[]; name: string; email: string }) {
  return <MarketplaceForm label="Save address" success="Address saved." reset fields={<>
    <label>Label<input name="label" placeholder="Home" minLength={2} maxLength={60} required/></label>
    <label>Full name<input name="name" defaultValue={name} autoComplete="name" minLength={2} maxLength={100} required/></label>
    <label>Phone number<input name="phone" type="tel" autoComplete="tel" placeholder="01XXXXXXXXX" maxLength={28} required/></label>
    <label>Email (optional)<input name="email" type="email" defaultValue={email} autoComplete="email" maxLength={254}/></label>
    <label>Delivery area<select name="district" required>{districts.map(zone => <option key={zone.id} value={zone.id}>{zone.label}</option>)}</select></label>
    <label>Area / Upazila<input name="locality" autoComplete="address-level2" minLength={2} maxLength={100} required/></label>
    <label>Street address<input name="address" autoComplete="street-address" minLength={5} maxLength={240} required/></label>
    <label>Postal code (optional)<input name="postalCode" autoComplete="postal-code" inputMode="numeric" pattern="[0-9]{4}" maxLength={4}/></label>
  </>} command={form => ({ action: "save-address", label: form.get("label"), customer: Object.fromEntries(
    ["name", "phone", "email", "district", "locality", "address", "postalCode"].map(field => [field, form.get(field)]),
  ) })}/>;
}

export function DeleteAddress({ id }: { id: string }) {
  return <MarketplaceForm label="Remove address" success="Address removed." command={() => ({ action: "delete-address", address: id })}/>;
}
