export function catalogMediaOrigins() {
  return (process.env.GRIIPBUDDY_CATALOG_MEDIA_ORIGINS ?? '').split(',').flatMap((entry) => {
    const value = entry.trim().replace(/\/$/, '');
    if (!/^https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(value)) return [];
    return [new URL(value).origin];
  });
}

export function approvedCatalogImage(value: string) {
  if (process.env.GRIIPBUDDY_DEV_CATALOG === '1' && /^\/(catalog|editorial)\/[a-z0-9-]+\.webp$/.test(value)) return value;
  try {
    const url = new URL(value);
    return !url.username && !url.password && catalogMediaOrigins().includes(url.origin) ? value : undefined;
  } catch {
    return undefined;
  }
}
