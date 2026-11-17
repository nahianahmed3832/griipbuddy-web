import { getDb } from "@/lib/db/client";
import { privateHeaders } from "@/lib/db/http";
import { canReadDevAdminOrders, readDevAdminOrderQuery, readDevAdminOrders } from "@/lib/staff/dev-admin-orders";

const headers = { ...privateHeaders, "X-Robots-Tag": "noindex, nofollow" };
const notFound = () => new Response(null, { status: 404, headers });

export async function GET(request: Request) {
  if (!canReadDevAdminOrders(request.headers.get("authorization"))) return notFound();
  const query = readDevAdminOrderQuery(new URL(request.url).searchParams);
  if (!query) return Response.json({ error: "Invalid order request." }, { status: 400, headers });
  try {
    const data = await readDevAdminOrders(getDb(), query);
    return data ? Response.json(data, { headers }) : notFound();
  } catch {
    return Response.json({ error: "Checkout orders are temporarily unavailable." }, { status: 503, headers });
  }
}
