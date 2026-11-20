import { NextResponse } from "next/server";
import { staffAuth } from "@/lib/staff/auth";
import { privateHeaders, sameOrigin } from "@/lib/db/http";
import { reportFailure } from "@/lib/db/observability";
import { storefrontPath } from "@/config/storefront-path";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403, headers: privateHeaders });
  try {
    const url = new URL(storefrontPath("/api/staff/sign-out"), process.env.BETTER_AUTH_URL);
    const response = await staffAuth().handler(new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: request.headers.get("origin")!,
        Cookie: request.headers.get("cookie") ?? "",
      },
      body: "{}",
    }));
    if (!response.ok) return NextResponse.json({ message: "Could not sign out. Try again." }, { status: 503, headers: privateHeaders });
    const next = NextResponse.json({ ok: true }, { headers: privateHeaders });
    for (const cookie of response.headers.getSetCookie()) next.headers.append("Set-Cookie", cookie);
    return next;
  } catch (error) {
    reportFailure("staff.sign-out", undefined, error);
    return NextResponse.json({ message: "Could not sign out. Try again." }, { status: 503, headers: privateHeaders });
  }
}
