import 'server-only';

export function canonicalOrigin() {
  const raw = process.env.GRIIPBUDDY_CANONICAL_ORIGIN;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined;
    if (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) return url.origin;
  } catch { /* Ignore invalid preview configuration. */ }
}

export function canonicalFor(path: string) {
  const origin = canonicalOrigin();
  return origin ? { alternates: { canonical: origin + path } } : {};
}
