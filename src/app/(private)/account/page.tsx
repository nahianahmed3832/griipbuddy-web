import Link from "next/link";
import { notFound } from "next/navigation";
import { marketplaceMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { getDb } from "@/lib/db/client";
import { deliveryChoices } from "@/lib/commerce/orders";
import { checkoutInput } from "@/lib/commerce/checkout-types";
import { SignInGate } from "@/components/marketplace/session";
import { DeleteAddress, PasswordForm, ProfileForm, SaveAddressForm } from "@/components/marketplace/account";

export const metadata = { title: "Account settings", robots: { index: false, follow: false } };

export default async function AccountPage() {
  if (!marketplaceMode()) notFound();
  const shopper = await getShopper();
  if (!shopper) return <div className="shell mp-page"><h1 className="mp-page-title">Account settings</h1><SignInGate>Sign in to manage your account.</SignInGate></div>;
  const [addresses, choices] = await Promise.all([
    getDb().shopperAddress.findMany({ where: { shopperId: shopper.id }, orderBy: { createdAt: "desc" }, take: 30 }),
    deliveryChoices("bd"),
  ]);
  const districts = [...new Map(choices.map(choice => [choice.district, { id: choice.district, label: choice.districtLabel }])).values()];
  return <div className="shell mp-page">
    <h1 className="mp-page-title">Account settings</h1><p>{shopper.email}</p>
    <nav className="mp-panel-links" aria-label="Account sections"><a href="#profile">Profile</a><a href="#addresses">Addresses</a>
      <a href="#password">Password</a><Link href="/favorites">Favorites</Link><Link href="/orders">Purchases and reviews</Link>
      <Link href="/account/alerts" prefetch={false}>Product alerts</Link></nav>
    <section className="mp-section" id="profile"><h2>Profile</h2><ProfileForm name={shopper.name}/></section>
    <section className="mp-section" id="addresses"><h2>Saved addresses</h2>
      {addresses.length > 0 && <ul className="mp-shop-grid mp-address-list">{addresses.map(row => {
        const json = row.details;
        const details = checkoutInput.shape.customer.safeParse(json && typeof json === "object" && !Array.isArray(json)
          ? { ...json, email: json.email ?? "", postalCode: json.postalCode ?? "" } : null);
        return <li className="mp-list-card" key={row.id}><strong>{row.label}</strong>
          {details.success && <p>{details.data.name}<br/>{details.data.address}<br/>{details.data.locality} · {details.data.phone}</p>}
          <DeleteAddress id={row.id}/></li>;
      })}</ul>}
      {districts.length > 0 && <SaveAddressForm districts={districts} name={shopper.name} email={shopper.email}/>}
    </section>
    <section className="mp-section" id="password"><h2>Change password</h2><PasswordForm/></section>
  </div>;
}
