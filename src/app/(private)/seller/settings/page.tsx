import Link from "next/link";
import { notFound } from "next/navigation";
import { SellerEmpty, SellerPageHeader, SellerStatus } from "@/components/marketplace/seller-ui";
import { SignInGate } from "@/components/marketplace/session";
import { WorkspaceCommandForm } from "@/components/marketplace/workspace-command-form";
import { getShopper } from "@/lib/marketplace/auth";
import { sellerMarketProfile, sellerVerificationLabels } from "@/lib/marketplace/seller-market-profile";
import { currentMarket } from "@/lib/market-server";
import "@/components/marketplace/workspace-command.css";

export const metadata = { title: "Shop settings" };

function AddressFields({ address }: { address?: { purpose: string; line: string; city: string; region: string; postal: string } }) {
  return <>
    <label>Address use<select name="purpose" defaultValue={address?.purpose ?? "business"}>
      <option value="business">Business address</option><option value="returns">Returns contact address</option>
    </select></label>
    <label>Street address<input name="line" required maxLength={180} defaultValue={address?.line}/></label>
    <label>City or locality<input name="city" required maxLength={90} defaultValue={address?.city}/></label>
    <label>State, region or district<input name="region" required maxLength={90} defaultValue={address?.region}/></label>
    <label>Postal code<input name="postal" maxLength={20} defaultValue={address?.postal}/></label>
  </>;
}

const reviewStatus: Record<string, string> = { SUBMITTED: "Awaiting review", ACCEPTED: "Accepted in test", DECLINED: "Revision requested" };

export default async function SellerSettings({ searchParams }: { searchParams: Promise<{ shop?: string | string[]; market?: string | string[] }> }) {
  const [shopper, market, query] = await Promise.all([getShopper(), currentMarket(), searchParams]);
  if (!shopper) return <div className="seller-entry"><SellerPageHeader title="Shop settings"/><SignInGate>Sign in to manage shop settings.</SignInGate></div>;
  if (query.market !== undefined && query.market !== market.id || Array.isArray(query.shop)) notFound();
  const selected = typeof query.shop === "string" ? query.shop : undefined;
  const settings = await sellerMarketProfile(shopper.id, market.id, selected);
  if (!settings) return <section className="seller-panel"><SellerEmpty title="Shop settings unavailable">
    This market requires an approved shop and the profile permission.
  </SellerEmpty></section>;
  const { shop, profile, baseline, addresses, form, submission, verification } = settings;
  const endpoint = `/api/marketplace/seller/profile?market=${market.id}`;
  const scope = { shopId: shop.id };
  return <>
    <SellerPageHeader title="Shop settings" description={`${shop.name} · ${market.name}`}
      actions={<Link className="seller-button" href={`/shops/${shop.slug}?market=${market.id}`}>View public shop</Link>}/>
    <div className="seller-grid">
      <section className="seller-panel">
        <h2>Shop presentation</h2>
        <WorkspaceCommandForm endpoint={endpoint} action="profile.save" values={{ ...scope, revision: profile?.revision ?? 0 }}
          submit="Save shop settings" key={profile?.revision}>
          <label>Public shop description<textarea name="about" rows={5} maxLength={1600} defaultValue={profile?.about ?? baseline?.about}/></label>
          <label>Public announcement<textarea name="announcement" rows={2} maxLength={200} defaultValue={profile?.announcement ?? baseline?.announcement}/></label>
          <label>Shop header style<select name="presentation" defaultValue={profile?.presentation ?? "classic"}>
            <option value="classic">Classic</option><option value="compact">Compact</option>
          </select></label>
          <label>Preferred seller language<select name="locale" defaultValue={profile?.locale ?? market.defaultLocale}>
            {market.languages.map(language => <option key={language} value={language}>{new Intl.DisplayNames([market.locale], { type: "language" }).of(language)}</option>)}
          </select></label>
        </WorkspaceCommandForm>
      </section>
      <section className="seller-panel">
        <h2>Business addresses</h2>
        <p className="seller-muted">Private business records for this market. Fulfillment sites are managed separately.</p>
        {!addresses.length && <SellerEmpty title="No business addresses"/>}
        {addresses.map(address => <details key={address.id} className="seller-settings-address">
          <summary>{address.purpose === "business" ? "Business" : "Returns"} · {address.city}</summary>
          <WorkspaceCommandForm key={address.revision} endpoint={endpoint} action="address.save" submit="Save address"
            values={{ ...scope, id: address.id, revision: address.revision }}>
            <AddressFields address={address}/>
          </WorkspaceCommandForm>
          <WorkspaceCommandForm endpoint={endpoint} action="address.archive" submit="Archive address"
            values={{ ...scope, id: address.id, revision: address.revision }}/>
        </details>)}
        <details className="seller-settings-address"><summary>Add a business address</summary>
          <WorkspaceCommandForm endpoint={endpoint} action="address.save" submit="Add address" values={{ ...scope, revision: 0 }}>
            <AddressFields/>
          </WorkspaceCommandForm>
        </details>
      </section>
    </div>
    <section className="seller-panel">
      <h2>Business verification</h2>
      {verification ? <>
        <p className="seller-muted">Test review accepts synthetic business information. Market access is reviewed separately.</p>
        {submission && <div><SellerStatus tone={submission.state === "ACCEPTED" ? "positive" : "warning"}>{reviewStatus[submission.state]}</SellerStatus>
          {submission.note && <p>{submission.note}</p>}</div>}
        {!form ? <SellerEmpty title="No review form is published for this market"/>
          : submission?.state !== "SUBMITTED" && <WorkspaceCommandForm endpoint={endpoint} action="verification.submit"
            values={{ ...scope, version: form.version }} submit="Submit for test review">
            {form.fields.map(name => <label key={name}>{sellerVerificationLabels[name]}{name === "summary"
              ? <textarea name={`answers.${name}`} rows={3} required maxLength={400}/>
              : <input name={`answers.${name}`} type={name === "website" ? "url" : "text"} required maxLength={name === "businessName" ? 120 : 400}/>}</label>)}
          </WorkspaceCommandForm>}
      </> : <SellerEmpty title="Business verification is unavailable"/>}
    </section>
  </>;
}
