import 'server-only';

export function publicBuild() {
  return process.env.GRIIPBUDDY_PUBLIC_DEV === '1';
}

// Only the hosted read-only preview uses the public retail catalog. Local public
// preview tests retain their isolated upstream and never contact the retail API.
export function hostedCatalogPreview() {
  return publicBuild() && process.env.GRIIPBUDDY_CANONICAL_ORIGIN === 'https://frontend.griipbuddy.com';
}

// Explicit opt-in for the isolated preview and its test suites.
export function fixturesEnabled() {
  return !hostedCatalogPreview() && process.env.GRIIPBUDDY_FIXTURES === '1';
}
