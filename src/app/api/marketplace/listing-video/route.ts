import { z } from "zod";
import { catalogVideoPrefix, videoUploadLimit } from "@/lib/catalog/video";
import { getDb } from "@/lib/db/client";
import { privateHeaders, readBody, sameOrigin } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { getShopper } from "@/lib/marketplace/auth";
import { MarketplaceError } from "@/lib/marketplace/write";
import { marketplaceMode } from "@/lib/release-config";
import { encodeCatalogVideo, videoUploadMessage } from "@/lib/staff/catalog-video";
import { lockProductEdits, OperationError } from "@/lib/staff/operations";

const input = z.object({
  product: z.string().regex(/^p-[a-z0-9-]{1,96}$/),
  variant: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/).optional(),
  action: z.enum(["upload", "remove"]),
});

export async function POST(request: Request) {
  if (!marketplaceMode()) return new Response(null, { status: 404 });
  const fail = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!sameOrigin(request)) return fail("Open this action from the storefront.", 403);
  try {
    const shopper = await getShopper();
    if (!shopper) return fail("Sign in first.", 401);
    const params = new URL(request.url).searchParams;
    const parsed = input.safeParse({
      product: params.get("product"), variant: params.get("variant") ?? undefined, action: params.get("action"),
    });
    if (!parsed.success) return fail("Choose a valid listing or variant.", 400);
    const { product, variant, action } = parsed.data;
    const db = getDb();
    const where = { id: product, publication: "DRAFT" as const, marketplaceShop: { ownerId: shopper.id } };
    if (!await db.product.findFirst({ where, select: { id: true } })) return fail("Draft listing unavailable.", 404);
    if (!await consumeQuota("marketplace.videos", shopper.id, 20, 86_400)) return fail("Daily video limit reached.", 429);
    let video: ReturnType<typeof encodeCatalogVideo> | null = null;
    if (action === "upload") {
      const data = await readBody(request, videoUploadLimit);
      if (!data) return fail(videoUploadMessage, 413);
      video = encodeCatalogVideo(data, request.headers.get("content-type") ?? "");
    }
    const videoUrl = video ? catalogVideoPrefix + video.id : null;
    await db.$transaction(async tx => {
      await lockProductEdits(tx, product);
      const updated = await tx.product.updateMany({
        where, data: { revision: { increment: 1 }, ...(variant === undefined && { videoUrl }) },
      });
      if (!updated.count) throw new MarketplaceError("Draft listing unavailable.", 404);
      if (variant) {
        const updatedVariant = await tx.variant.updateMany({ where: { id: variant, productId: product, active: true }, data: { videoUrl } });
        if (!updatedVariant.count) throw new MarketplaceError("Variant unavailable.", 404);
      }
      if (video) await tx.catalogMedia.upsert({ where: { id: video.id }, update: {}, create: video });
    });
    return Response.json({ data: { src: videoUrl } }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof MarketplaceError) return fail(error.message, error.status);
    if (error instanceof OperationError) return fail(error.message, 422);
    reportFailure("marketplace.video", undefined, error);
    return fail("The video could not be saved. Try again.", 503);
  }
}
