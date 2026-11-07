import { hostedCatalogPreview, publicBuild } from '@/features/public-build';
import 'server-only';

import { checkoutPreferences } from '@/features/checkout/admin-preferences';
import { checkoutEnabled } from '@/features/checkout/runtime';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { marketForSegment, type Market } from '@/features/catalog/catalog';

import { countryForIp } from './ip-country';

export const marketCookie = 'griipbuddy-market';

export function withInternational(markets: Market[]): Market[] {
  const code = checkoutEnabled() ? checkoutPreferences().fallback : (process.env.GRIIPBUDDY_INTERNATIONAL_COUNTRY ?? 'US').trim().toUpperCase();
  const source = markets.find((market) => market.code === code && market.region === 'INTERNATIONAL');
  return [...markets, {
    id: source?.id ?? '', code: 'INTL', name: 'International', currency: source?.currency ?? 'USD',
    locale: source?.locale ?? 'en-US', region: 'INTERNATIONAL', prefix: '/international',
    catalogCountry: source?.code,
  }];
}

export const resolveMarket = cache(async (markets: Market[], segment?: string) => {
  const explicit = marketForSegment(markets, segment);
  if (explicit) return { market: explicit, explicit: true };

  const saved = marketForSegment(markets, (await cookies()).get(marketCookie)?.value);
  if (saved) return { market: saved, explicit: false };

  // Enable this only behind a trusted proxy that overwrites the configured header.
  const name = process.env.GRIIPBUDDY_COUNTRY_HEADER?.toLowerCase();
  const requestHeaders = await headers();
  const hint = name && /^(?:x-[a-z0-9-]+|cf-ipcountry|cloudfront-viewer-country)$/.test(name) ? requestHeaders.get(name) : null;
  // The hosted preview listens on loopback. Its Nginx virtual host replaces
  // X-Forwarded-For with the trusted remote address.
  const country = hint && /^[a-z]{2}$/i.test(hint) && hint.toUpperCase() !== 'XX'
    ? hint
    : hostedCatalogPreview() ? await countryForIp(requestHeaders.get('x-forwarded-for')) : undefined;
  const international = markets.find((market) => market.code === 'INTL');
  const detected = country ? marketForSegment(markets, country) ?? international : undefined;
  const fallback = (publicBuild() ? marketForSegment(markets, 'bd') : undefined) ?? international;
  if (!fallback) throw new Error('International storefront is not configured.');
  return { market: detected ?? fallback, explicit: false };
});
