import { catalogVideoPrefix } from "@/lib/catalog/video";
import { publicShop } from "@/lib/catalog/repository";
import { getDb } from "@/lib/db/client";
import { reportFailure } from "@/lib/db/observability";
import { getShopper } from "@/lib/marketplace/auth";
import { marketplaceMode, productionMode } from "@/lib/release-config";
import { getStaff } from "@/lib/staff/access";
import { catalogVideoContentType } from "@/lib/staff/catalog-video";

function rangeBounds(range: string, length: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, length - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), length - 1) : length - 1;
  return start < length && end >= start ? { start, end } : null;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9]{64}$/.test(id)) return new Response(null, { status: 404 });
  try {
    const db = getDb();
    const videoUrl = catalogVideoPrefix + id;
    const linked = { OR: [{ videoUrl }, { variants: { some: { videoUrl, active: true } } }] };
    const publicVideo = await db.product.findFirst({
      where: { publication: "ACTIVE", demo: productionMode() ? false : undefined, AND: [publicShop(), linked] },
      select: { id: true },
    });
    if (!publicVideo && (await getStaff())?.role !== "OWNER") {
      const shopper = marketplaceMode() ? await getShopper() : null;
      if (!shopper || !await db.product.findFirst({
        where: { ...linked, marketplaceShop: { ownerId: shopper.id } }, select: { id: true },
      })) return new Response(null, { status: 404 });
    }
    const video = await db.catalogMedia.findUnique({ where: { id, contentType: catalogVideoContentType }, select: { data: true } });
    if (!video) return new Response(null, { status: 404 });
    const length = video.data.byteLength;
    const headers = new Headers({
      "Content-Type": catalogVideoContentType,
      "Cache-Control": publicVideo ? "private, max-age=3600, immutable" : "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
    });
    const range = request.headers.get("range");
    if (range && request.method === "GET") {
      const bounds = rangeBounds(range, length);
      if (!bounds) {
        headers.set("Content-Range", `bytes */${length}`);
        return new Response(null, { status: 416, headers });
      }
      const { start, end } = bounds;
      headers.set("Content-Range", `bytes ${start}-${end}/${length}`);
      headers.set("Content-Length", String(end - start + 1));
      return new Response(Buffer.from(video.data.subarray(start, end + 1)), { status: 206, headers });
    }
    headers.set("Content-Length", String(length));
    return new Response(request.method === "HEAD" ? null : Buffer.from(video.data), { headers });
  } catch (error) {
    reportFailure("video.read", undefined, error);
    return new Response(null, { status: 503 });
  }
}

export const HEAD = GET;
