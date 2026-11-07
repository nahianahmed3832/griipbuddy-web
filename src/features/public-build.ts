import 'server-only';

export function publicBuild() {
  return process.env.GRIIPBUDDY_PUBLIC_DEV === '1';
}

// Explicit opt-in for the isolated preview and its test suites.
export function fixturesEnabled() {
  return process.env.GRIIPBUDDY_FIXTURES === '1';
}
