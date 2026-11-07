import 'server-only';

export function publicBuild() {
  return process.env.GRIIPBUDDY_PUBLIC_DEV === '1';
}
