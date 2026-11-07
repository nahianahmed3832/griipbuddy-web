import 'server-only';

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { cookies } from 'next/headers';
import { hostedCatalogPreview } from '@/features/public-build';
import { text } from './contracts';
import { googleFixtureAccount } from './fixture';
import { setSession } from './session';

const origin = 'https://frontend.griipbuddy.com';
const redirectUri = origin + '/api/sign-in/google/callback';
const flowCookie = '__Host-griip-google';
const lifetime = 300;
const cookieOptions = { secure: true, httpOnly: true, sameSite: 'lax' as const, path: '/' };
const random = () => randomBytes(32).toString('base64url');

function config() {
  const clientId = process.env.GRIIPBUDDY_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GRIIPBUDDY_GOOGLE_CLIENT_SECRET?.trim();
  return hostedCatalogPreview() && clientId?.endsWith('.apps.googleusercontent.com') && clientSecret
    ? { clientId, clientSecret } : undefined;
}

export function googleSignInEnabled() {
  return Boolean(config());
}

function redirect(path: string) {
  return new Response(null, { status: 303, headers: {
    Location: new URL(path, origin).href,
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
  } });
}

const unavailable = () => new Response('Google sign-in is unavailable.', {
  status: 404, headers: { 'Cache-Control': 'private, no-store' },
});

function marketPrefix(value: unknown) {
  return typeof value === 'string' && /^\/[a-z]{2}$/.test(value) ? value : '/bd';
}

type Flow = { state: string; nonce: string; verifier: string; market: string; expires: number };
const signature = (payload: string, secret: string) => createHmac('sha256', secret).update(payload).digest('base64url');
function equal(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseFlow(cookie: string, secret: string): Flow | undefined {
  const [payload, mac, extra] = cookie.split('.');
  if (!payload || !mac || extra !== undefined || !equal(mac, signature(payload, secret))) return undefined;
  try {
    const flow: Flow = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return flow.expires >= Date.now() ? flow : undefined;
  } catch { return undefined; }
}

export async function startGoogle(request: Request) {
  const settings = config();
  if (!settings) return unavailable();
  const client = new OAuth2Client({ ...settings, redirectUri });
  const flow: Flow = { state: random(), nonce: random(), verifier: random(),
    market: marketPrefix(new URL(request.url).searchParams.get('market')), expires: Date.now() + lifetime * 1000 };
  const payload = Buffer.from(JSON.stringify(flow)).toString('base64url');
  (await cookies()).set(flowCookie, payload + '.' + signature(payload, settings.clientSecret), { ...cookieOptions, maxAge: lifetime });
  const url = new URL(client.generateAuthUrl({
    scope: ['openid', 'email', 'profile'],
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'),
    state: flow.state,
  }));
  url.searchParams.set('nonce', flow.nonce);
  return redirect(url.href);
}

export async function finishGoogle(request: Request) {
  const settings = config();
  if (!settings) return unavailable();
  const jar = await cookies();
  const flow = parseFlow(jar.get(flowCookie)?.value ?? '', settings.clientSecret);
  jar.set(flowCookie, '', { ...cookieOptions, maxAge: 0 });
  const market = marketPrefix(flow?.market);
  const failure = () => redirect(market + '/login?google=failed');
  const params = new URL(request.url).searchParams;
  const code = params.get('code');
  const state = params.get('state');
  if (!flow || !code || code.length > 2048 || !state || !equal(state, flow.state) || params.has('error')) return failure();
  try {
    const client = new OAuth2Client({ ...settings, redirectUri });
    const { tokens } = await client.getToken({ code, codeVerifier: flow.verifier, redirect_uri: redirectUri });
    if (!tokens.id_token) return failure();
    const claims = (await client.verifyIdToken({ idToken: tokens.id_token, audience: settings.clientId })).getPayload();
    if (!claims?.sub || !claims.email_verified || !('nonce' in claims) || claims.nonce !== flow.nonce) return failure();
    const account = await googleFixtureAccount(claims.sub, text(claims.given_name, 80));
    // The callback always uses the fixed public HTTPS origin even behind the dev reverse proxy.
    await setSession(new Request(redirectUri), { mode: 'fixture', id: account.profile.id });
    return redirect(market + '/account');
  } catch { return failure(); }
}
