"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { markets, type MarketId } from "@/config/markets";
import { northAmericanAddressProfiles } from "@/config/address-profiles";
import { storefrontPath } from "@/config/storefront-path";
import type { AddressCommand, SavedAddress } from "@/lib/marketplace/address-command";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";

type AddressAction = Omit<Extract<AddressCommand, { action: "create-address" }>, "marketId"> |
  Omit<Extract<AddressCommand, { action: "update-address" }>, "marketId"> |
  Omit<Extract<AddressCommand, { action: "remove-address" }>, "marketId"> |
  Omit<Extract<AddressCommand, { action: "default-address" }>, "marketId">;
type District = { id: string; label: string };

function useAddressChange(marketId: MarketId, language: AccountLanguage) {
  const router = useRouter();
  const active = useRef(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: true }>();
  const [addressSnapshot, setAddressSnapshot] = useState<SavedAddress[]>();
  const t = (en: string, bn: string) => accountText(language, en, bn);

  async function change(command: AddressAction, success: string) {
    if (active.current) return false;
    active.current = true;
    setPending(true);
    setStatus(undefined);
    try {
      const response = await fetch(storefrontPath("/api/marketplace"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...command, marketId }),
      });
      if (!response.ok) {
        const message = response.status === 401 ? t("Sign in to manage your addresses.", "ঠিকানা পরিচালনা করতে সাইন ইন করুন।")
          : response.status === 404 ? t("This address is no longer available here.", "এই ঠিকানাটি এখানে আর পাওয়া যাচ্ছে না।")
          : response.status === 400 || response.status === 422
            ? t("Check the address and recipient details. Remove an existing address if your list is full.",
              "ঠিকানা ও প্রাপকের তথ্য যাচাই করুন। ঠিকানার তালিকা পূর্ণ হলে একটি পুরোনো ঠিকানা সরান।")
            : t("We couldn’t save the change. Try again.", "পরিবর্তনটি সংরক্ষণ করা যায়নি। আবার চেষ্টা করুন।");
        setStatus({ text: message, error: true });
        return false;
      }
      const result = await response.json() as { data?: { addresses?: SavedAddress[] } };
      setStatus({ text: success });
      if (result.data?.addresses) setAddressSnapshot(result.data.addresses);
      else router.refresh();
      return true;
    } catch {
      setStatus({ text: t("We couldn’t save the change. Try again.", "পরিবর্তনটি সংরক্ষণ করা যায়নি। আবার চেষ্টা করুন।"), error: true });
      return false;
    } finally {
      active.current = false;
      setPending(false);
    }
  }
  return { change, pending, status, addressSnapshot };
}

const districtNames: Readonly<Record<string, string>> = { dhaka: "ঢাকা", chattogram: "চট্টগ্রাম", gazipur: "গাজীপুর", narayanganj: "নারায়ণগঞ্জ" };
export function addressDistrictName(district: District, language: AccountLanguage) {
  return accountText(language, district.label, districtNames[district.id] ?? district.label);
}

function AddressForm({ row, marketId, districts, pending, language, onSave, onCancel }: {
  row?: SavedAddress; marketId: MarketId; districts: readonly District[]; pending: boolean; language: AccountLanguage;
  onSave: (command: AddressAction) => Promise<boolean>; onCancel?: () => void;
}) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const bd = row?.marketId === "bd" ? row.details : null;
  const northAmerica = row?.marketId !== "bd" ? row?.details : null;
  const addressProfile = markets[marketId].addressProfile;
  const profile = addressProfile === "district" ? null : northAmericanAddressProfiles[addressProfile];
  const districtAvailable = districts.some(district => district.id === bd?.district);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = (name: string) => String(data.get(name) ?? "");
    const recipient = { name: value("name"), phone: value("phone"), email: value("email") };
    const details = profile ? {
      ...recipient, country: profile.country, addressLine1: value("addressLine1"), addressLine2: value("addressLine2"), city: value("city"),
      state: value("state"), postalCode: value("postalCode"),
    } : {
      ...recipient, country: "BD", district: value("district"), locality: value("locality"), address: value("address"),
      postalCode: value("postalCode"), landmark: value("landmark"), alternatePhone: value("alternatePhone"), instructions: value("instructions"),
    };
    const payload = { details, label: value("label") };
    if (await onSave(row ? { action: "update-address", address: row.id, ...payload } : { action: "create-address", ...payload }) && !row) {
      form.reset();
    }
  }

  return <form className="mp-form" onSubmit={submit}>
    <fieldset className="commerce-form" disabled={pending}>
      <legend className="sr-only">{row ? t("Edit address", "ঠিকানা সম্পাদনা করুন") : t("Add an address", "ঠিকানা যোগ করুন")}</legend>
      <label>{t("Address label", "ঠিকানার নাম")}<input name="label" defaultValue={row?.label} placeholder={t("Home", "বাসা")}
        minLength={2} maxLength={60} required /></label>
      <label>{t("Recipient name", "প্রাপকের নাম")}<input name="name" defaultValue={(bd ?? northAmerica)?.name} autoComplete="shipping name"
        minLength={2} maxLength={100} required /></label>
      <label>{t("Recipient phone", "প্রাপকের মোবাইল নম্বর")}<input name="phone" defaultValue={(bd ?? northAmerica)?.phone} type="tel"
        autoComplete="shipping tel" maxLength={28} required /></label>
      <label>{t("Recipient email (optional)", "প্রাপকের ইমেইল (ঐচ্ছিক)")}<input name="email" defaultValue={(bd ?? northAmerica)?.email}
        type="email" autoComplete="shipping email" maxLength={254} /></label>
      {!profile ? <>
        <label>{t("District", "জেলা")}<select name="district" required defaultValue={districtAvailable ? bd?.district : ""}>
          <option value="">{t("Choose a district", "জেলা নির্বাচন করুন")}</option>
          {districts.map(district => <option key={district.id} value={district.id}>{addressDistrictName(district, language)}</option>)}
        </select></label>
        <label>{t("Area or upazila", "এলাকা বা উপজেলা")}<input name="locality" defaultValue={bd?.locality}
          autoComplete="shipping address-level2" minLength={2} maxLength={100} required /></label>
        <label>{t("House and street", "বাড়ি ও রাস্তার ঠিকানা")}<input name="address" defaultValue={bd?.address}
          autoComplete="shipping street-address" minLength={5} maxLength={240} required /></label>
        <label>{t("Postal code (optional)", "পোস্টকোড (ঐচ্ছিক)")}<input name="postalCode" defaultValue={bd?.postalCode}
          autoComplete="shipping postal-code" inputMode="numeric" pattern="[0-9০-৯]{4}" maxLength={4} /></label>
        <label>{t("Landmark (optional)", "কাছের পরিচিত স্থান (ঐচ্ছিক)")}<input name="landmark" defaultValue={bd?.landmark} maxLength={120} /></label>
        <label>{t("Alternate phone (optional)", "বিকল্প মোবাইল নম্বর (ঐচ্ছিক)")}<input name="alternatePhone" defaultValue={bd?.alternatePhone}
          type="tel" maxLength={28} /></label>
        <label>{t("Delivery instructions (optional)", "ডেলিভারির নির্দেশনা (ঐচ্ছিক)")}<input name="instructions" defaultValue={bd?.instructions} maxLength={180} /></label>
      </> : <>
        <label>Street address<input name="addressLine1" defaultValue={northAmerica?.addressLine1} autoComplete="shipping address-line1"
          minLength={5} maxLength={120} required /></label>
        <label>Apartment or suite (optional)<input name="addressLine2" defaultValue={northAmerica?.addressLine2}
          autoComplete="shipping address-line2" maxLength={120} /></label>
        <label>City<input name="city" defaultValue={northAmerica?.city} autoComplete="shipping address-level2" minLength={2} maxLength={100} required /></label>
        <label>{profile.regionLabel}<select name="state" defaultValue={northAmerica?.state ?? ""} autoComplete="shipping address-level1" required>
          <option value="">{profile.regionPrompt}</option>
          {profile.regions.map(([code, label]) => <option value={code} key={code}>{label}</option>)}
        </select></label>
        <label>{profile.postalLabel}<input name="postalCode" defaultValue={northAmerica?.postalCode} autoComplete="shipping postal-code"
          maxLength={profile.postalLength} inputMode={profile.postalNumeric ? "numeric" : "text"} pattern={profile.postalPattern} required /></label>
      </>}
      <div className="mp-panel-links">
        <button type="submit" className="button button--primary">{t("Save address", "ঠিকানা সংরক্ষণ করুন")}</button>
        {onCancel && <button type="button" className="button button--outline" onClick={onCancel}>{t("Cancel", "বাতিল")}</button>}
      </div>
    </fieldset>
  </form>;
}

export function AddressBook({ marketId, language, addresses, districts }: {
  marketId: MarketId; language: AccountLanguage; addresses: readonly SavedAddress[]; districts: readonly District[];
}) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const [editing, setEditing] = useState<string>();
  const [removing, setRemoving] = useState<string>();
  const { change, pending, status, addressSnapshot } = useAddressChange(marketId, language);
  const displayAddresses = addressSnapshot ?? addresses;
  const available = markets[marketId].addressProfile !== "district" || districts.length > 0;
  async function save(command: AddressAction) {
    const ok = await change(command, t("Address saved.", "ঠিকানা সংরক্ষণ করা হয়েছে।"));
    if (ok) setEditing(undefined);
    return ok;
  }

  return <>
    {status && <p className="commerce-message" role={status.error ? "alert" : "status"}>{status.text}</p>}
    {!displayAddresses.length && <p>{t("You have no saved addresses in this country.", "এই দেশে আপনার কোনো সংরক্ষিত ঠিকানা নেই।")}</p>}
    <ul className="mp-shop-grid mp-address-list">{displayAddresses.map(row => {
      const bd = row.marketId === "bd" ? row.details : null;
      const northAmerica = row.marketId !== "bd" ? row.details : null;
      return <li className="mp-list-card" key={row.id}>
        <strong>{row.label}</strong>
        {row.isDefault && <p>{t("Default delivery address", "ডিফল্ট ডেলিভারি ঠিকানা")}</p>}
        {bd && <p>{bd.name}<br />{bd.address}<br />{bd.locality}{bd.landmark && <><br />{bd.landmark}</>}<br />{bd.phone}</p>}
        {northAmerica && <p>{northAmerica.name}<br />{[northAmerica.addressLine1, northAmerica.addressLine2].filter(Boolean).join(", ")}<br />
          {northAmerica.city}, {northAmerica.state} {northAmerica.postalCode}<br />{northAmerica.phone}</p>}
        {!row.details && <p>{t("Review the details before using this address.", "ঠিকানাটি ব্যবহারের আগে তথ্য যাচাই করুন।")}</p>}
        {editing === row.id ? <AddressForm row={row} marketId={marketId} districts={districts} pending={pending} language={language}
          onSave={save} onCancel={() => setEditing(undefined)} /> : <div className="mp-panel-links">
          {available && <button type="button" className="link-button" disabled={pending}
            onClick={() => { setEditing(row.id); setRemoving(undefined); }}>{t("Edit", "সম্পাদনা করুন")}</button>}
          {!row.isDefault && row.details && <button type="button" className="link-button" disabled={pending}
            onClick={() => void change({ action: "default-address", address: row.id }, t("Default address updated.", "ডিফল্ট ঠিকানা হালনাগাদ হয়েছে।"))}>
            {t("Set as default", "ডিফল্ট করুন")}</button>}
          {removing === row.id ? <>
            <button type="button" className="link-button" disabled={pending} onClick={() => void change(
              { action: "remove-address", address: row.id }, t("Address deleted.", "ঠিকানা মুছে ফেলা হয়েছে।"),
            ).then(ok => { if (ok) setRemoving(undefined); })}>{t("Confirm delete", "ঠিকানা মুছে ফেলুন")}</button>
            <button type="button" className="link-button" disabled={pending} onClick={() => setRemoving(undefined)}>{t("Cancel", "বাতিল")}</button>
          </> : <button type="button" className="link-button" disabled={pending}
            onClick={() => setRemoving(row.id)}>{t("Delete", "মুছুন")}</button>}
        </div>}
      </li>;
    })}</ul>
    {available ? <section className="mp-section">
      <h2>{t("Add an address", "ঠিকানা যোগ করুন")}</h2>
      <AddressForm marketId={marketId} districts={districts} pending={pending} language={language} onSave={save} />
    </section> : <p role="status">{t("Delivery districts are temporarily unavailable.", "ডেলিভারির জেলার তালিকা সাময়িকভাবে পাওয়া যাচ্ছে না।")}</p>}
  </>;
}

export function SaveCheckoutAddress({ marketId, language, details }: { marketId: MarketId; language: AccountLanguage; details: unknown }) {
  const { change, pending, status } = useAddressChange(marketId, language);
  const t = (en: string, bn: string) => accountText(language, en, bn);
  return <>
    <button className="button button--outline" disabled={pending} type="button"
      onClick={() => void change({ action: "create-address", label: t("Delivery address", "ডেলিভারি ঠিকানা"), details },
        t("Address saved to your account.", "ঠিকানাটি আপনার অ্যাকাউন্টে সংরক্ষণ করা হয়েছে।"))}>
      {t("Save this address", "এই ঠিকানা সংরক্ষণ করুন")}
    </button>
    {status && <p className="commerce-message" role={status.error ? "alert" : "status"}>{status.text}</p>}
  </>;
}
