import sharp from "sharp";
import { getDb } from "@/lib/db/client";
import { reportFailure } from "@/lib/db/observability";
import { getStaff } from "@/lib/staff/access";
import { hybridDemoMode, marketplaceMode, productionMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { publicShop } from "@/lib/catalog/repository";
import { catalogMediaPath, catalogMediaWidth } from "@/lib/catalog/media-size";

const privateHeaders = { "Cache-Control": "private, no-store" };
const unavailable = (status: number) => new Response(null, { status, headers: privateHeaders });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const src = "/media/" + id;
  if (!catalogMediaPath.test(src)) return unavailable(404);
  const demo = hybridDemoMode();
  const width = demo ? catalogMediaWidth(new URL(request.url).searchParams.getAll("w")) : undefined;
  if (width === null) return unavailable(400);
  try {
    const db = getDb();
    const active = { ...publicShop(), publication: "ACTIVE" as const, demo: productionMode() ? false : undefined };
    const [gallery, variant] = await Promise.all([
      db.productImage.findFirst({ where: { src, product: active }, select: { productId: true } }),
      db.variant.findFirst({ where: { imageSrc: src, active: true, product: active }, select: { id: true } }),
    ]);
    const publicImage = Boolean(gallery || variant);
    if (!publicImage && (await getStaff())?.role !== "OWNER") {
      const shopper = marketplaceMode() ? await getShopper() : null;
      if (!shopper || !await db.productImage.findFirst({ where: { src, product: { marketplaceShop: { ownerId: shopper.id } } },
        select: { productId: true } })) return unavailable(404);
    }
    const image = await db.catalogMedia.findUnique({ where: { id }, select: { data: true } });
    if (!image) return unavailable(404);
    const data = width ? await sharp(image.data, { limitInputPixels: 16_000_000 })
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: width <= 640 ? 74 : 83 })
      .toBuffer() : image.data;
    const cacheControl = !publicImage ? privateHeaders["Cache-Control"]
      : demo ? "private, max-age=900" : "private, max-age=31536000, immutable";
    return new Response(new Uint8Array(data), { headers: {
      "Content-Type": "image/webp", "Content-Length": String(data.length), "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    reportFailure("media.read", undefined, error);
    return unavailable(503);
  }
}
