import Link from "next/link";
import { notFound } from "next/navigation";
import { marketplaceMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { currentMarket } from "@/lib/market-server";
import { fulfillmentLabels, orderDate, orderLabels } from "@/lib/commerce/labels";
import { parcelOrderLabel } from "@/lib/commerce/parcel-tracking";
import { shopperOrders, shopperSelections } from "@/lib/marketplace/data";
import { addressBook, addressDistricts } from "@/lib/marketplace/address-book";
import { SignInGate } from "@/components/marketplace/session";
import { AddressBook, PasswordForm, ProfileForm } from "@/components/marketplace/account";
import { AccountPanel, AccountShortcut, AccountShortcuts, AccountWorkspace } from "@/components/marketplace/account-workspace";
import { store } from "@/config/store";
import { MeasurementPreferences } from "@/components/measurement-preferences";

export const metadata = { title: "Your account", robots: { index: false, follow: false } };

export default async function AccountPage() {
  if (!marketplaceMode()) notFound();
  const [shopper, market] = await Promise.all([getShopper(), currentMarket()]);
  if (!shopper) return <AccountWorkspace title="Your account" market={market}>
    <SignInGate>Sign in to manage your purchases and account.</SignInGate>
    <p>Need help signing in? <a className="text-link" href={`mailto:${store.supportEmail}`}>Contact GriipBuddy support</a>.</p>
  </AccountWorkspace>;

  const [addresses, districts, selections, orders] = await Promise.all([
    addressBook(shopper.id, market.id), addressDistricts(market.id),
    shopperSelections(shopper.id, market.id), shopperOrders(shopper.id, null),
  ]);
  const latest = orders[0];

  return <AccountWorkspace title="Your account" description={`Welcome, ${shopper.name}`} market={market} active="/account">
    <AccountPanel title="Overview">
      <AccountShortcuts>
        <AccountShortcut title="Orders" href="/orders" summary={latest ? `Latest order ${latest.reference}` : "No purchases yet"}/>
        <AccountShortcut title="Saved products" href="/favorites" summary={`${selections.favorites.length}${selections.favorites.length === 300 ? "+" : ""} available in ${market.name}`}/>
        <AccountShortcut title="Messages" href="/messages" summary="Follow replies from GriipBuddy and shops"/>
      </AccountShortcuts>
      {latest && <p><Link href={`/orders/${latest.id}`} className="text-link">{latest.reference}</Link>{" · "}
        {latest.status === "CANCELLED" ? orderLabels.CANCELLED
          : latest.parcels.length ? parcelOrderLabel(latest.parcels) : fulfillmentLabels[latest.fulfillmentStatus]}{" · "}
        <time dateTime={latest.createdAt.toISOString()}>{orderDate(latest.createdAt, latest.marketId)}</time>
      </p>}
    </AccountPanel>
    <AccountPanel title="Profile" id="profile">
      <p><strong>Sign-in email</strong> {shopper.email} <small>{shopper.emailVerified ? "(verified)" : "(unverified)"}</small></p>
      <ProfileForm name={shopper.name}/>
    </AccountPanel>
    <AccountPanel title="Saved addresses" id="addresses">
      <p>Addresses are saved separately for each shopping market.</p>
      <AddressBook key={market.id} addresses={addresses} districts={districts} market={market}
        name={shopper.name} email={shopper.email}/>
    </AccountPanel>
    <AccountPanel title="Password and sessions" id="security">
      <p>Changing your password signs out your other sessions.</p>
      <PasswordForm/>
      <p>For help verifying your email or recovering access, <Link href="/messages" className="text-link">contact support</Link>.</p>
    </AccountPanel>
    <AccountPanel title="Preferences" id="preferences">
      <p><Link href="/account/alerts" prefetch={false} className="text-link">Manage product alerts</Link> for watched variants. Alerts appear in your account.</p>
      <MeasurementPreferences marketId={market.id}/>
    </AccountPanel>
  </AccountWorkspace>;
}
