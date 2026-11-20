import { notFound } from "next/navigation";
import { SellerPageHeader, SellerEmpty, SellerStatus } from "@/components/marketplace/seller-ui";
import { SellerHubForm } from "@/components/marketplace/seller-hub-form";
import { SignInGate } from "@/components/marketplace/session";
import { currentMarket } from "@/lib/market-server";
import { getShopper } from "@/lib/marketplace/auth";
import { sellerPermissions, type SellerPermission } from "@/lib/marketplace/seller-access";
import { sellerTeamPage } from "@/lib/marketplace/seller-team";
import { firstPartyStoreMode } from "@/lib/release-config";

export const metadata = { title: "Seller team", robots: { index: false, follow: false } };
const permissionLabels: Record<SellerPermission, string> = {
  PROFILE: "Manage shop profile", LISTINGS: "Work on products and shop inventory",
  ORDER_PREPARATION: "Prepare the shop’s orders", SUPPORT: "Handle support and Hub messages",
  FINANCE_VIEW: "View financial statements", PAYOUT_REQUEST: "Request payouts", PAYOUT_DESTINATION: "Manage payout destinations",
};
const permissionText = (permissions: SellerPermission[]) => permissions.map(permission => permissionLabels[permission]).join(", ");

export default async function Team({ searchParams }: { searchParams: Promise<{ market?: string | string[] }> }) {
  if (firstPartyStoreMode()) notFound();
  const [query, market, shopper] = await Promise.all([searchParams, currentMarket(), getShopper()]);
  if (query.market !== undefined && query.market !== market.id) notFound();
  if (!shopper) return <div className="seller-entry"><SellerPageHeader title="Seller team"/><SignInGate>
    Sign in to see your market-scoped invitations.
  </SignInGate></div>;
  const { shop, invitations } = await sellerTeamPage(shopper.id, market.id);
  const formScope = { section: "team" as const, market: market.id };
  return <>
    <SellerPageHeader title="Seller team" description={shop ? `${shop.name} · ${market.name}` : market.name}/>
    {invitations.length > 0 && <section className="seller-panel" aria-labelledby="seller-team-invitations">
      <div className="seller-panel-heading"><h2 id="seller-team-invitations">Invitations</h2></div>
      <ul className="mp-shop-grid">{invitations.map(invite => <li key={invite.shopId}>
        <strong>{invite.shop.name}</strong><p>{permissionText(invite.permissions)}</p>
        <SellerHubForm {...formScope} command={{ action: "team.accept", shopId: invite.shopId }}
          label="Accept invitation" success="Invitation accepted."/>
      </li>)}</ul>
    </section>}
    {shop ? <>
      <section className="seller-panel" aria-labelledby="seller-team-members">
        <div className="seller-panel-heading"><h2 id="seller-team-members">Members</h2></div>
        {!shop.teamMembers.length ? <SellerEmpty title="No team members at this market"/> :
          <div className="seller-table-wrap"><table className="seller-table" aria-labelledby="seller-team-members">
            <thead><tr><th scope="col">Member</th><th scope="col">Permissions</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
            <tbody>{shop.teamMembers.map(member => <tr key={member.shopperId}>
              <td data-label="Member">{member.shopper.name}<br/>{member.shopper.email}</td>
              <td data-label="Permissions">{permissionText(member.permissions)}</td>
              <td data-label="Status"><SellerStatus tone={member.acceptedAt ? "positive" : "warning"}>
                {member.acceptedAt ? "Active" : "Invited"}</SellerStatus></td>
              <td data-label="Action"><SellerHubForm {...formScope}
                command={{ action: "team.revoke", shopId: shop.id, memberId: member.shopperId }}
                label="Revoke access" success="Access revoked."/></td>
            </tr>)}</tbody>
          </table></div>}
      </section>
      <section className="seller-panel" aria-labelledby="seller-team-invite">
        <div className="seller-panel-heading"><div><h2 id="seller-team-invite">Invite a team member</h2>
          <p className="seller-muted">Use an existing verified shopper account. New permissions require the recipient’s acceptance.</p></div></div>
        <SellerHubForm {...formScope} command={{ action: "team.invite", shopId: shop.id }} label="Save invitation" success="Invitation saved." reset>
          <label>Account email<input type="email" name="email" maxLength={254} required/></label>
          <input type="hidden" name="team-permissions" value="independent"/>
          <fieldset><legend>Permissions for {market.name}</legend>
            {sellerPermissions.map(permission => <label key={permission}>
              <input type="checkbox" name="permissions" value={permission}/> {permissionLabels[permission]}
            </label>)}
          </fieldset>
        </SellerHubForm>
      </section>
    </> : invitations.length === 0 && <div className="seller-entry"><SellerEmpty title="No pending invitations">
      New invitations for your account appear here.
    </SellerEmpty></div>}
  </>;
}
