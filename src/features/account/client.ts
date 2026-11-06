'use client';

export async function accountRequest<T = Record<string, unknown>>(action: string, data: unknown = {}) {
  const response = await fetch('/api/account/' + action, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Your account is temporarily unavailable.');
  return body as T;
}
