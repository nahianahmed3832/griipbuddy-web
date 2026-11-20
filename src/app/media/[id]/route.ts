import { getDb } from "@/lib/db/client";
import { reportFailure } from "@/lib/db/observability";
import { getStaff } from "@/lib/staff/access";
import { marketplaceMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { availableMarketEditorialMedia } from "@/lib/catalog/repository";
import { isMarketSelectable, marketConfiguration, marketLanguage } from "@/lib/market-config";
import { currentMarket } from "@/lib/market-server";
import { publishedEditorial } from "@/lib/catalog/editorial";
import { isPublishedHomepageMedia } from "@/lib/catalog/homepage-content";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9]{64}$/.test(id)) return new Response(null, { status: 404 });
  try {
    const db = getDb();
    const src = "/media/" + id;
    const query = new URL(request.url).searchParams;
    const urlMarkets = query.getAll("market");
    const languages = query.getAll("lang");
    const requested = urlMarkets[0];
    if (urlMarkets.length > 1 || languages.length > 1 || (requested !== undefined && !isMarketSelectable(requested))) {
      return new Response(null, { status: 404 });
    }
    const current = await currentMarket();
    const market = isMarketSelectable(requested) && requested !== current.id ? marketConfiguration(requested) : current;
    const locale = languages.length ? marketLanguage(market, languages[0]) : market.locale;
    if (!locale) return new Response(null, { status: 404 });
    const publicImage = (await availableMarketEditorialMedia([src], market.id)).has(src) ||
      await isPublishedHomepageMedia(src, { ...market, locale }) ||
      (await publishedEditorial(market.id, locale)).documents.some(item => item.image?.src === src);
    if (!publicImage && (await getStaff())?.role !== "OWNER") {
      const shopper = marketplaceMode() ? await getShopper() : null;
      if (!shopper) return new Response(null, { status: 404 });
      const [attached, uploaded] = await Promise.all([
        db.productImage.findFirst({ where: { src, product: { marketplaceShop: { ownerId: shopper.id } } },
          select: { productId: true } }),
        db.sellerListingAsset.findFirst({ where: { mediaId: id, shop: { ownerId: shopper.id } }, select: { mediaId: true } }),
      ]);
      if (!attached && !uploaded) return new Response(null, { status: 404 });
    }
    const image = await db.catalogMedia.findUnique({ where: { id }, select: { data: true } });
    if (!image) return new Response(null, { status: 404 });
    return new Response(Buffer.from(image.data), { headers: {
      "Content-Type": "image/webp", "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    reportFailure("media.read", undefined, error);
    return new Response(null, { status: 503 });
  }
}
