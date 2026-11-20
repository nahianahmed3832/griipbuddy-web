import { z } from "zod";
import { scopedCatalogPilotRequested } from "@/lib/catalog/main-admin-config";
import { requireLegacyPilotProduct, requireScopedLegacyWriter } from "@/lib/catalog/scoped-pilot";
import { getDb } from "@/lib/db/client";
import { sameOrigin, readBody, privateHeaders } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { marketplaceMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { encodeCatalogImage, uploadLimit } from "@/lib/staff/catalog-media";
import { lockProductEdits, OperationError } from "@/lib/staff/operations";

export async function POST(request: Request) {
  if (!marketplaceMode()) return new Response(null, { status: 404 });
  const fail = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!sameOrigin(request)) return fail("Open this action from the storefront.", 403);
  const shopper = await getShopper();
  if (!shopper) return fail("Sign in first.", 401);
  const params = new URL(request.url).searchParams;
  const product = z.string().regex(/^p-[a-z0-9-]{1,96}$/).safeParse(params.get("product"));
  const alt = z.string().trim().min(1).max(180).safeParse(params.get("alt"));
  if (!product.success || !alt.success) return fail("Enter a photo description.", 400);
  try {
    const db = getDb();
    const where = { id: product.data, publication: "DRAFT" as const, marketplaceShop: { ownerId: shopper.id } };
    if (!await db.product.findFirst({ where, select: { id: true } })) return fail("Draft listing unavailable.", 404);
    if (!await consumeQuota("marketplace.photos", shopper.id, 12, 86_400)) return fail("Daily test photo limit reached.", 429);
    const data = await readBody(request, uploadLimit);
    if (!data) return fail("Use a JPEG, PNG or WebP file up to 4 MB.", 413);
    const image = await encodeCatalogImage(data, request.headers.get("content-type") ?? "");
    const path = `/media/${image.id}`;
    return await db.$transaction(async tx => {
      if (scopedCatalogPilotRequested()) {
        await lockProductEdits(tx, product.data);
        if (!await tx.product.findFirst({ where, select: { id: true } })) return fail("Draft listing unavailable.", 404);
        await requireScopedLegacyWriter(tx);
        await requireLegacyPilotProduct(tx, product.data, true);
      }
      const current = await tx.product.updateMany({ where, data: { revision: { increment: 1 } } });
      if (!current.count) return fail("Draft listing unavailable.", 404);
      const gallery = await tx.productImage.findMany({ where: { productId: product.data }, select: { position: true, src: true },
        orderBy: { position: "desc" }, take: 6 });
      if (gallery.some(row => row.src === path)) return fail("This photo is already on the listing.", 409);
      if (gallery.length >= 6) return fail("A draft can have up to six photos.", 409);
      await tx.catalogMedia.upsert({ where: { id: image.id }, create: image, update: {} });
      await tx.productImage.create({ data: { productId: product.data, position: (gallery[0]?.position ?? 0) + 1, src: path, alt: alt.data } });
      return Response.json({ data: { src: path } }, { headers: privateHeaders });
    });
  } catch (error) {
    if (error instanceof OperationError) return fail(error.message, 422);
    reportFailure("marketplace.photo", undefined, error);
    return fail("We couldn't save the photo.", 503);
  }
}
