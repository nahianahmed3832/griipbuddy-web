import 'server-only';
import { hostedCatalogPreview } from '@/features/public-build';
import { cache } from 'react';
import { approvedCatalogImage, approvedCatalogVideo } from '@/features/catalog/media';
import { record, rows } from '@/features/catalog/api';
import { marketHref, type Market } from '@/features/catalog/catalog';
import type { CampaignSlide } from './campaign-stage';

export const text = (value: unknown) => typeof value === 'string' ? value : '';
export const contentRows = (value: unknown) => rows(value).map(record);
export const contentPath = (value: unknown) => /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/.test(text(value)) ? text(value) : undefined;

export function contentMedia(value: unknown) {
  const source = text(value);
  if (/^\/(?:editorial|catalog|brand)\/[a-z0-9/_-]+\.(?:webp|png|jpe?g|mp4|webm)$/i.test(source)) return source;
  return approvedCatalogImage(source);
}

export const siteContent = cache(async () => {
  if (hostedCatalogPreview()) return {};
  const base = process.env.GRIIPBUDDY_CONTENT_API;
  if (!base || !/^http:\/\/127\.0\.0\.1:\d{4,5}\/api\/v1$/.test(base)) return {};
  try {
    const response = await fetch(base + '/cms/site-content', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(2500) });
    if (!response.ok) return {};
    const envelope = record(await response.json());
    return envelope.success === true ? record(envelope.data) : {};
  } catch { return {}; }
});

function campaignMedia(value: unknown, video: boolean) {
  const source = text(value);
  const approved = video ? approvedCatalogVideo(source) : contentMedia(source);
  if (approved) return approved;
  try {
    const url = new URL(source);
    const format = video ? /\.(mp4|webm)$/i : /\.(avif|webp|png|jpe?g)$/i;
    // Staff-supplied media is requested by the browser directly, never by the image optimizer.
    return url.protocol === 'https:' && !url.username && !url.password && format.test(url.pathname) ? url.href : undefined;
  } catch { return undefined; }
}

export function campaignSlides(value: unknown, market: Market): CampaignSlide[] {
  return contentRows(value).sort((a, b) => Number(a.position) - Number(b.position)).flatMap((row) => {
    const image = campaignMedia(row.thumbnail_url, false);
    const video = campaignMedia(row.video_url, true);
    if (!image && !video) return [];
    const button = record(row.button);
    const route = button.enabled === true ? contentPath(button.redirect_route) : undefined;
    return [{ title: text(row.title) || 'Featured campaign', image, video,
      href: route ? marketHref(market, route) : undefined, label: text(button.text) }];
  }).slice(0, 5);
}

export const managedHeroContent = cache(async () => {
  // The hosted storefront uses the protected Admin's isolated CMS, independent of the catalog source.
  const base = process.env.GRIIPBUDDY_HERO_CONTENT_API ?? 'http://127.0.0.1:14819/api/v1';
  if (!/^http:\/\/127\.0\.0\.1:\d{4,5}\/api\/v1$/.test(base)) return [];
  try {
    const response = await fetch(base + '/cms/site-content', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(2000) });
    if (!response.ok) return [];
    const envelope = record(await response.json());
    return envelope.success === true ? contentRows(record(envelope.data).hero_section) : [];
  } catch { return []; }
});
