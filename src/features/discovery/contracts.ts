export const discoveryLinks = [
  { path: '/discover', label: 'Discover' },
  { path: '/deals', label: 'Deals' },
  { path: '/group-buy', label: 'Group Buy' },
  { path: '/coupons', label: 'Coupons' },
] as const;

export type DiscoveryPath = typeof discoveryLinks[number]['path'];

export type CouponOffer = {
  code: string;
  description?: string;
  discount: { type: 'percent' | 'fixed'; amount: number };
  minSpend?: number;
  maxDiscount?: number;
  endsAt?: string;
  firstOrder: boolean;
  restrictedItems: boolean;
  fixture: boolean;
};

export type Campaign = {
  id: string;
  title: string;
  description: string;
  productSlugs: string[];
  startsAt: string;
  endsAt: string;
};

export type GroupCampaign = Campaign & {
  goal: number;
  participants: number;
  tiers: { minimum: number; percent: number }[];
};
