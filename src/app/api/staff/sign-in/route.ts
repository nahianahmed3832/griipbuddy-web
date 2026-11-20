import { NextResponse } from "next/server";
import { z } from "zod";
import { staffAuth } from "@/lib/staff/auth";
import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { clientKey, consumeQuota, reportFailure } from "@/lib/db/observability";
import { storefrontPath } from "@/config/storefront-path";

const credentials = z.object({ email: z.email().max(254), password: z.string().min(1).max(128) });

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ message: "Open staff sign-in from this storefront." }, { status: 403, headers: privateHeaders });
  const parsed = credentials.safeParse(await readJson(request, 4096));
  if (!parsed.success) return NextResponse.json({ message: "Check your email and password." }, { status: 400, headers: privateHeaders });
  try {
    const ip = clientKey(request.headers);
    if (!await consumeQuota("staff.sign-in", ip, 25, 300)) {
      return NextResponse.json({ message: "Too many attempts. Try again in a few minutes." }, {
        status: 429, headers: { ...privateHeaders, "Retry-After": "300" },
      });
    }
    // Pass through Better Auth's HTTP handler so its origin checks and database rate limit apply.
    const url = new URL(storefrontPath("/api/staff/sign-in/email"), process.env.BETTER_AUTH_URL);
    const response = await staffAuth().handler(new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Origin: request.headers.get("origin")!,
        ...(ip === "unattributed" ? {} : { "X-Forwarded-For": ip }),
      },
      body: JSON.stringify({ ...parsed.data, rememberMe: false }),
    }));
    if (!response.ok) {
      const message = response.status === 429 ? "Too many attempts. Try again in a minute." : "The email or password was not accepted.";
      return NextResponse.json({ message }, { status: response.status, headers: privateHeaders });
    }
    const next = NextResponse.json({ ok: true }, { headers: privateHeaders });
    for (const cookie of response.headers.getSetCookie()) next.headers.append("Set-Cookie", cookie);
    return next;
  } catch (error) {
    reportFailure("staff.sign-in", undefined, error);
    return NextResponse.json({ message: "Staff sign-in is temporarily unavailable." }, { status: 503, headers: privateHeaders });
  }
}
