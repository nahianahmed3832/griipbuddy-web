import { acquisitionCampaign, acquisitionDestination } from "./campaign.ts";

// This package has no ad write adapter. A future adapter must require this guard
// and authenticated readbacks; its evidence comes from the owner and server.
export function acquisitionActivationBlockers(input: {
  destination: string;
  observed?: { finalUrl: string; publicStatus: number; productId: string; variantId: string; currency: string; priceMinor: number; available: number };
  authorization?: { ownerApproved: boolean; campaign: string; account: string; currency: string; limitMinor: number; start: string; end: string };
  now: Date;
  approvedContent: boolean;
  verifiedGeography: boolean;
  verifiedLiveOrderMatching: boolean;
  pausedObjectsVerified: boolean;
}) {
  const issues: string[] = [];
  const evidence = input.observed;
  if (input.destination !== acquisitionDestination || evidence?.finalUrl !== acquisitionDestination || evidence.publicStatus !== 200 ||
      evidence.productId !== acquisitionCampaign.productId || evidence.variantId !== acquisitionCampaign.variantId ||
      evidence.currency !== "BDT" || evidence.priceMinor !== 15000 || !Number.isSafeInteger(evidence.available) || evidence.available < 5) {
    issues.push("Verify the exact public landing page, BDT price, variant and minimum stock.");
  }
  const approval = input.authorization;
  if (approval?.ownerApproved !== true || approval.campaign !== acquisitionCampaign.label ||
      approval.account !== "act_1410454054233870" || approval.currency !== "USD" ||
      !Number.isSafeInteger(approval.limitMinor) || approval.limitMinor <= 0) {
    issues.push("Owner approval for this campaign, Meta account and total USD spend is required.");
  }
  const start = new Date(approval?.start ?? "");
  const end = new Date(approval?.end ?? "");
  const midnightDhaka = /^\d{4}-\d{2}-\d{2}T00:00:00\+06:00$/;
  if (!midnightDhaka.test(approval?.start ?? "") || !midnightDhaka.test(approval?.end ?? "") ||
      !(+start > +input.now) || +end - +start !== 7 * 86_400_000) {
    issues.push("Approve a future seven-day schedule in Asia/Dhaka.");
  }
  if (!input.approvedContent) issues.push("Approve this catalog version and ad creative.");
  if (!input.verifiedGeography) issues.push("Verify the approved delivery coverage and published checkout fees.");
  if (!input.verifiedLiveOrderMatching) issues.push("Verify live consent and checkout-to-order matching.");
  if (!input.pausedObjectsVerified) issues.push("Read back the paused Meta campaign, ad set and ad.");
  return issues;
}
