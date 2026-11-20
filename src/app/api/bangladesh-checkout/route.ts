import { bangladeshCheckoutEnabled, bangladeshCheckoutUrl, resolveBangladeshHandoff } from "@/lib/commerce/bangladesh-handoff";
import { privateHeaders, readBody, sameOrigin } from "@/lib/db/http";
import { currentMarket } from "@/lib/market-server";
import { storefrontPath } from "@/config/storefront-path";

export async function POST(request: Request) {
  const backToCart = () => new Response(null, {
    status: 303, headers: { ...privateHeaders, Location: storefrontPath("/cart") },
  });
  if (!sameOrigin(request)) return new Response(null, { status: 403, headers: privateHeaders });
  const market = await currentMarket();
  if (!bangladeshCheckoutEnabled(market.id)) return backToCart();
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return backToCart();
  const form = await readBody(request, 12_000);
  if (!form) return backToCart();

  let raw: unknown;
  try { raw = JSON.parse(new URLSearchParams(form.toString("utf8")).get("items") ?? ""); }
  catch { return backToCart(); }
  const items = await resolveBangladeshHandoff(raw, market.id);
  if (!items.length) return backToCart();

  const destination = new URL("/bd/checkout/transfer", bangladeshCheckoutUrl);
  destination.hash = items.map(({ productId, variantId, quantity }) => `${productId}:${variantId}:${quantity}`).join(",");
  return new Response(null, { status: 303, headers: { ...privateHeaders, Location: destination.href } });
}
