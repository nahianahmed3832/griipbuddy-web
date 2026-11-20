import { getDb } from "@/lib/db/client";
import { privateHeaders } from "@/lib/db/http";
import { reportFailure } from "@/lib/db/observability";
import { marketplaceMode, orderIntakeOpen, productionMode } from "@/lib/release-config";
import { bangladeshCheckoutEnabled } from "@/lib/commerce/bangladesh-handoff";

export const dynamic = "force-dynamic";

export async function GET() {
  const revision = process.env.APP_REVISION ?? "local";
  try {
    await getDb().$queryRaw`SELECT "publication" FROM "Product" LIMIT 1`;
    if (marketplaceMode()) await getDb().$queryRaw`SELECT "id" FROM "MarketplaceShop" LIMIT 1`;
    const handoff = bangladeshCheckoutEnabled();
    const release = productionMode() ? {
      visibility: "public",
      orderIntake: handoff || orderIntakeOpen() ? "open" : "closed",
      ...(handoff && { bangladeshCheckout: "griipbuddy.com" }),
    } : marketplaceMode() ? {
      visibility: "marketplace-preview", orderIntake: orderIntakeOpen() ? "test-only" : "closed",
    } : {};
    return Response.json({ app: "griipbuddy-storefront", revision, database: "ok", ...release }, { headers: privateHeaders });
  } catch (error) {
    reportFailure("health.database", undefined, error);
    return Response.json({ app: "griipbuddy-storefront", revision, database: "unavailable" }, { status: 503, headers: privateHeaders });
  }
}
