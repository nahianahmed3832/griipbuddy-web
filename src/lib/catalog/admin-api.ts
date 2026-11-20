import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { Prisma, type StaffRole } from "../../generated/prisma/client.ts";
import { privateHeaders, readBody, sameOrigin } from "../db/http.ts";
import { consumeQuota, reportFailure } from "../db/observability.ts";
import { marketIdInput } from "../market-config.ts";
import { saveProductCategoryAssignments } from "../staff/category-assignments.ts";
import { saveCatalogAttributeDefinition, saveCategoryAttributeTemplate } from "../staff/category-attributes.ts";
import { saveDeviceModel, saveVariantCompatibility } from "../staff/device-fitment.ts";
import { saveCatalogCollection, saveCollectionMarketPublication, saveMarketMenu, setCuratedCollectionProducts } from "../staff/navigation.ts";
import { CatalogWriteError, OperationError, catalogWriteInput } from "../staff/operation-error.ts";
import { saveProductGallery, saveProductTranslation } from "../staff/product-presentation.ts";
import { saveWorkspaceOffer, saveWorkspaceProduct, setWorkspaceProductPublication } from "../staff/product-publication.ts";
import { runWorkspaceStockCommand, workspaceStockCommands } from "../staff/product-workspace-commerce.ts";
import {
  archiveCategory, moveCategory, reorderCategories, saveCategory, saveCategoryMarketPresentation, saveCategoryTranslation,
} from "../staff/taxonomy.ts";

export type CatalogMutationActor = { kind: "staff"; id: string; role: StaffRole } | { kind: "seller"; id: string };

const catalogCommands = {
  "category.save": saveCategory,
  "category.move": moveCategory,
  "category.archive": archiveCategory,
  "category.reorder": reorderCategories,
  "category.translation": saveCategoryTranslation,
  "category.presentation": saveCategoryMarketPresentation,
  "category.attribute": saveCategoryAttributeTemplate,
  "attribute.save": saveCatalogAttributeDefinition,
  "menu.save": saveMarketMenu,
  "collection.save": saveCatalogCollection,
  "collection.publish": saveCollectionMarketPublication,
  "collection.products": setCuratedCollectionProducts,
  "product.assignments": saveProductCategoryAssignments,
  "product.save": saveWorkspaceProduct,
  "product.publish": setWorkspaceProductPublication,
  "product.translation": saveProductTranslation,
  "product.gallery": saveProductGallery,
  "variant.compatibility": saveVariantCompatibility,
  "device.save": saveDeviceModel,
};

const offerCommands = new Set(["offer.save", "offer.configure"]);
const commandInput = z.strictObject({
  action: z.string().max(50).refine(action => offerCommands.has(action) || workspaceStockCommands.has(action) || Object.hasOwn(catalogCommands, action),
    "Choose a catalog command."),
  input: z.record(z.string(), z.unknown()),
});
const marketTaxonomyCommands = new Set(["category.presentation", "menu.save", "collection.publish"]);
export const maxCommandBytes = 512 * 1024;

const send = (data: object, status: number) => Response.json(data, { status, headers: privateHeaders });
const fail = (status: number, code: string, message: string, fields?: CatalogWriteError["fields"]) =>
  send({ error: { code, message, ...(fields?.length ? { fields } : {}) } }, status);

export function sellerCatalogUnavailable() {
  return fail(404, "not_found", "Seller catalog commands are unavailable.");
}

export function catalogCommandPermission(action: string) {
  if (marketTaxonomyCommands.has(action)) return "merchandising";
  if (offerCommands.has(action) || workspaceStockCommands.has(action)) return "commercial";
  return "owner";
}

export async function handleCatalogMutation(request: Request, access: {
  actor: () => Promise<CatalogMutationActor | null>;
  market: () => Promise<MarketId>;
  nativePilotMerchandising?: boolean;
}) {
  if (!sameOrigin(request)) return fail(403, "forbidden", "Open this action from the catalog workspace.");
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return fail(415, "unsupported_media_type", "Use an application/json catalog command.");
  }
  try {
    const actor = await access.actor();
    if (!actor) return fail(401, "authentication_required", "Sign in to edit the catalog.");
    if (!await consumeQuota("catalog.write", `${actor.kind}:${actor.id}`, 100, 600)) {
      return fail(429, "rate_limited", "Too many catalog commands. Try again in a few minutes.");
    }
    const body = await readBody(request, maxCommandBytes);
    if (!body) return fail(413, "body_limit", "Send a catalog command up to 512 KB.");
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
    catch { return fail(400, "invalid_input", "The catalog command is not valid JSON."); }
    return send({ data: await runCatalogCommand(raw, actor, access.market, access.nativePilotMerchandising) }, 200);
  } catch (error) {
    return catalogErrorResponse(error, "catalog.write");
  }
}

export async function runCatalogCommand(raw: unknown, actor: CatalogMutationActor, market: () => Promise<MarketId>, nativePilotMerchandising = false) {
  const { action, input } = catalogWriteInput(commandInput, raw);
  const permission = catalogCommandPermission(action);
  if (permission !== "commercial" && (actor.kind !== "staff" || (permission === "owner" && actor.role !== "OWNER"))) {
    throw new CatalogWriteError("forbidden", "Central owner access is required for this catalog command.");
  }
  if (permission !== "owner") {
    const { marketId } = catalogWriteInput(z.object({ marketId: marketIdInput }), input);
    if (marketId !== await market()) {
      throw new CatalogWriteError("market_mismatch", "Switch to the selected market and retry.");
    }
  }
  if (nativePilotMerchandising) {
    if (actor.kind !== "staff" || actor.role === "OWNER" || !marketTaxonomyCommands.has(action)) {
      throw new CatalogWriteError("forbidden", "Use the main GriipBuddy admin for this catalog command.");
    }
    if (action === "category.presentation") return saveCategoryMarketPresentation(actor.id, input, true);
    if (action === "menu.save") return saveMarketMenu(actor.id, input, true);
    return saveCollectionMarketPublication(actor.id, input, true);
  }
  const commercialActor = { kind: actor.kind, id: actor.id };
  if (offerCommands.has(action)) return saveWorkspaceOffer(commercialActor, input);
  if (workspaceStockCommands.has(action)) return runWorkspaceStockCommand(commercialActor, action, input);
  return catalogCommands[action as keyof typeof catalogCommands](actor.id, input);
}

export function catalogErrorResponse(error: unknown, operation: string) {
  if (error instanceof CatalogWriteError) return fail(error.status, error.code, error.message, error.fields);
  if (error instanceof OperationError) return fail(422, "rule_violation", error.message);
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002" || error.code === "P2003" || error.code === "P2034") {
      return fail(409, "conflict", "The catalog changed or the supplied identity is in use. Reload the record before retrying.");
    }
    if (error.code === "P2025") return fail(404, "not_found", "The catalog record could not be found.");
  }
  reportFailure(operation, undefined, error);
  return fail(503, "unavailable", "The catalog request could not be completed.");
}
