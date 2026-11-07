import 'server-only';

import { catalogGet, apiConfigured, record, rows } from '@/features/catalog/api';
import { parseCoupon } from '@/features/cart/cart';
import type { Market } from '@/features/catalog/catalog';
import { fixturesEnabled } from '@/features/public-build';
import type { Campaign, CouponOffer, GroupCampaign } from './contracts';

function positive(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeCoupon(value: unknown, now: number): CouponOffer | undefined {
  const row = record(value);
  const code = typeof row.code === 'string' ? parseCoupon(row.code) : undefined;
  const amount = positive(row.discountValue);
  const type = row.discountType === 'PERCENTAGE' ? 'percent' : row.discountType === 'FLAT' ? 'fixed' : undefined;
  const startsAt = typeof row.startAt === 'string' ? Date.parse(row.startAt) : NaN;
  const endsAt = typeof row.expireAt === 'string' ? Date.parse(row.expireAt) : NaN;
  if (!code || !amount || !type || (type === 'percent' && amount > 100) || row.isActive !== true
      || !Number.isFinite(startsAt) || !Number.isFinite(endsAt) || now < startsAt || now >= endsAt
      || rows(row.userIds).length || (typeof row.usageLimit === 'number' && Number(row.usedCount ?? 0) >= row.usageLimit)) return;
  return {
    code,
    description: typeof row.description === 'string' ? row.description.trim().slice(0, 240) : undefined,
    discount: { type, amount },
    minSpend: positive(row.minOrderAmount),
    maxDiscount: positive(row.maxDiscountAmount),
    endsAt: new Date(endsAt).toISOString(),
    firstOrder: row.firstOrderOnly === true,
    restrictedItems: ['categoryIds', 'subcategoryIds', 'sub_subcategoryIds', 'productIds', 'variant'].some((key) => rows(row[key]).length > 0),
    fixture: false,
  };
}

export async function couponOffers(market: Market): Promise<{ offers: CouponOffer[]; unavailable?: boolean }> {
  if (fixturesEnabled() && !apiConfigured() && ['US', 'BD'].includes(market.code)) {
    return { offers: [{ code: 'PREVIEW10', description: 'Try applying this sample code in your shopping bag.',
      discount: { type: 'percent', amount: 10 }, firstOrder: false, restrictedItems: false, fixture: true }] };
  }

  // Legacy coupons carry no market or currency. Only the BDT storefront has a defined interpretation.
  if (!apiConfigured() || market.code !== 'BD' || market.currency !== 'BDT') return { offers: [] };
  try {
    const payload = record(await catalogGet('/coupon/public/active', new URLSearchParams({ limit: '24' })));
    const now = Date.now();
    return { offers: rows(payload.coupons).flatMap((row) => normalizeCoupon(row, now) ?? []) };
  } catch {
    return { offers: [], unavailable: true };
  }
}

const fixtureSale: Campaign = {
  id: 'carry-edit', title: 'The carry edit', description: 'A sample limited-time campaign for the Arc Shoulder Bag.',
  productSlugs: ['arc-bag'], startsAt: '2026-11-07T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
};

const fixtureGroup: GroupCampaign = {
  id: 'market-tote-circle', title: 'The Market Tote circle', description: 'Walk through a shared shopping offer with the Market Tote.',
  productSlugs: ['market-tote'], startsAt: '2026-11-07T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
  goal: 4, participants: 1, tiers: [{ minimum: 2, percent: 5 }, { minimum: 4, percent: 10 }],
};

export function campaigns(market: Market): { sales: Campaign[]; groups: GroupCampaign[] } {
  if (!fixturesEnabled() || apiConfigured() || market.currency !== 'USD') return { sales: [], groups: [] };
  return { sales: [fixtureSale], groups: [fixtureGroup] };
}
