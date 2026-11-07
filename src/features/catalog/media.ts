import { hostedCatalogPreview } from '@/features/public-build';

const retailMediaOrigin = 'https://d11ml80zmgyrxk.cloudfront.net';
const retailImagePath = /^\/?uploads\/[a-z0-9_-]+\.(?:webp|png|jpe?g|avif)$/i;

export function catalogMediaOrigins() {
  return (process.env.GRIIPBUDDY_CATALOG_MEDIA_ORIGINS ?? '').split(',').flatMap((entry) => {
    const value = entry.trim().replace(/\/$/, '');
    if (!/^https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(value)) return [];
    return [new URL(value).origin];
  });
}

export function approvedCatalogImage(value: string) {
  if (hostedCatalogPreview()) {
    const path = value.startsWith(retailMediaOrigin + '/') ? value.slice(retailMediaOrigin.length) : value;
    return retailImagePath.test(path) ? new URL(path, retailMediaOrigin).href : undefined;
  }
  if (process.env.GRIIPBUDDY_DEV_CATALOG === '1' && /^\/(catalog|editorial)\/[a-z0-9-]+\.webp$/.test(value)) return value;
  try {
    const url = new URL(value);
    return !url.username && !url.password && catalogMediaOrigins().includes(url.origin) ? value : undefined;
  } catch {
    return undefined;
  }
}
