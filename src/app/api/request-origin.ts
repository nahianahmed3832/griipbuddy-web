export function sameOriginRequest(request: Request) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  const url = new URL(request.url);
  // Next may normalize its request URL to localhost while the browser used 127.0.0.1.
  return origin === url.protocol + '//' + (request.headers.get('host') ?? url.host);
}
