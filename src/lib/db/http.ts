export const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
};

export function sameOrigin(request: Request): boolean {
  const expected = process.env.BETTER_AUTH_URL;
  if (!expected) return false;
  try {
    return request.headers.get("origin") === new URL(expected).origin;
  } catch {
    return false;
  }
}

export function secureCookies(): boolean {
  return process.env.BETTER_AUTH_URL?.startsWith("https://") ?? false;
}

export function browserCredentialsPresent(headers: Headers) {
  return ["origin", "cookie", "sec-fetch-site", "sec-fetch-dest"].some(name => headers.has(name));
}

export async function readBody(request: Pick<Request, "headers" | "body">, limit: number): Promise<Buffer | null> {
  if (!request.body || Number(request.headers.get("content-length")) > limit) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export async function readJson(request: Request, limit = 32_768): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) return null;
  const body = await readBody(request, limit);
  try {
    return body ? JSON.parse(body.toString("utf8")) : null;
  } catch {
    return null;
  }
}
