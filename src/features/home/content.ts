import 'server-only';
import { cache } from 'react';
import { approvedCatalogImage } from '@/features/catalog/media';
import { record, rows } from '@/features/catalog/api';

export const text = (value: unknown) => typeof value === 'string' ? value : '';
export const contentRows = (value: unknown) => rows(value).map(record);
export const contentPath = (value: unknown) => /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/.test(text(value)) ? text(value) : undefined;

export function contentMedia(value: unknown) {
  const source = text(value);
  if (/^\/(?:editorial|catalog|brand)\/[a-z0-9/_-]+\.(?:webp|png|jpe?g|mp4|webm)$/i.test(source)) return source;
  return approvedCatalogImage(source);
}

export const siteContent = cache(async () => {
  const base = process.env.GRIIPBUDDY_CONTENT_API;
  if (!base || !/^http:\/\/127\.0\.0\.1:\d{4,5}\/api\/v1$/.test(base)) return {};
  try {
    const response = await fetch(base + '/cms/site-content', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(2500) });
    if (!response.ok) return {};
    const envelope = record(await response.json());
    return envelope.success === true ? record(envelope.data) : {};
  } catch { return {}; }
});
