import type { Market } from "@/config/markets";
import { activeOffer, offerTimerEnd } from "@/lib/marketplace/dev-offer";
import { SaleCountdown } from "./sale-countdown";

export function SaleOfferCountdown({
  campaign, market, className,
}: {
  campaign: ReturnType<typeof activeOffer>;
  market: Market;
  className?: string;
}) {
  const timer = campaign && offerTimerEnd(campaign, campaign.now);
  if (!campaign || !timer) return null;

  const end = new Date(timer);
  const rollsOver = timer < campaign.end;
  const deadlineLabel = end.toLocaleString(market.locale, {
    timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short",
  });
  return (
    <div className={className}>
      <SaleCountdown key={timer} endsAt={end.toISOString()} initialSeconds={Math.ceil((timer - campaign.now) / 1000)}
        deadlineLabel={deadlineLabel} label={rollsOver ? "Offer timer resets in" : "Sale ends in"}
        endedLabel={rollsOver ? "Updating offer timer" : "Sale ended"} />
    </div>
  );
}
