export function activeDiscount(offer: {
  discountMinor: number | null;
  discountStartsAt: Date | null;
  discountEndsAt: Date | null;
}, at: Date): number {
  if (offer.discountMinor === null || !offer.discountStartsAt || !offer.discountEndsAt) return 0;
  return offer.discountStartsAt <= at && at < offer.discountEndsAt ? offer.discountMinor : 0;
}
