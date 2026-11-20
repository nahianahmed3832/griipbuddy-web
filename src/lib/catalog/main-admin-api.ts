import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getDb } from "../db/client.ts";
import { privateHeaders, readBody } from "../db/http.ts";
import { consumeQuota } from "../db/observability.ts";
import { isMarketSelectable, marketIdInput } from "../market-config.ts";
import { storeCatalogImage, uploadLimit } from "../staff/catalog-media.ts";
import { productMediaUploadAvailable } from "../staff/catalog-media-upload.ts";
import { runStaffCatalogSearchMaintenance } from "../staff/catalog-search-maintenance.ts";
import { mainAdminOrderPermission, runMainAdminOrderCommand } from "../staff/main-admin-orders.ts";
import { catalogWriteInput, CatalogWriteError } from "../staff/operation-error.ts";
import { catalogCommandPermission, catalogErrorResponse, maxCommandBytes, runCatalogCommand } from "./admin-api.ts";
import { legacyStaffIdPattern, mainAdminCatalogConfig, mainAdminMarketplaceConfig } from "./main-admin-config.ts";
import { mainAdminReadInput, mainAdminReadPermission, readMainAdminCatalog } from "./main-admin-reads.ts";
import { isHomepageCommand, mainAdminHomepageReadInput, readMainAdminHomepage, runMainAdminHomepage } from "./main-admin-homepage.ts";
import { mainAdminMarketplace, mainAdminMarketplaceInput } from "./main-admin-marketplace.ts";

const signaturePrefix = "griip-main-admin-catalog-v1\n";
const maxAgeMs = 60_000;
const maxUploadEncodedBytes = Math.ceil(uploadLimit / 3) * 4;
const maxEnvelopeBytes = maxUploadEncodedBytes + 4096;

const command = z.strictObject({
  action: z.string().min(1).max(50), input: z.record(z.string(), z.unknown()),
});
const legacyOperationInput = z.union([mainAdminReadInput, command]);
const envelope = z.strictObject({
  issuedAt: z.int(), nonce: z.uuid(), legacyId: z.string().regex(legacyStaffIdPattern), central: z.boolean(),
  marketId: marketIdInput, request: z.unknown(),
});
const upload = z.strictObject({
  data: z.string().min(4).max(maxUploadEncodedBytes),
  mime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
}).refine(value => Boolean(value.mime || value.contentType) &&
  (!value.mime || !value.contentType || value.mime === value.contentType), "Choose the source image type.");

const responseHeaders = { ...privateHeaders, "X-Robots-Tag": "noindex, nofollow" };
const fail = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status, headers: responseHeaders });

async function uploadImage(actorId: string, raw: unknown) {
  const { data, mime, contentType } = catalogWriteInput(upload, raw);
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > uploadLimit || bytes.toString("base64") !== data) {
    throw new CatalogWriteError("invalid_input", "Supply a valid base64-encoded image of up to 4 MB.");
  }
  return { src: await storeCatalogImage(actorId, bytes, mime ?? contentType ?? "") };
}

export async function handleMainAdminCatalog(request: Request, onMutation?: () => void, onHomepagePublication?: () => void) {
  const channel = request.headers.get("x-griip-admin-channel");
  if (channel !== null && channel !== "homepage" && channel !== "marketplace") return fail(404, "not_found", "This endpoint is unavailable.");
  const homepage = channel === "homepage";
  const marketplace = channel === "marketplace";
  const config = marketplace ? mainAdminMarketplaceConfig() : mainAdminCatalogConfig(homepage);
  if (!config) return fail(404, "not_found", "This endpoint is unavailable.");
  const signature = request.headers.get("x-griip-catalog-signature");
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site") ||
      !signature || !/^[a-f0-9]{64}$/.test(signature)) {
    return fail(401, "authentication_required", "A signed request from the GriipBuddy admin is required.");
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return fail(415, "unsupported_media_type", "Use an application/json catalog request.");
  }
  const body = await readBody(request, maxEnvelopeBytes);
  if (!body) return fail(413, "body_limit", "The signed catalog request exceeds its size limit.");
  const digest = createHmac("sha256", config.secret).update(marketplace ? "griip-main-admin-marketplace-v1\n" : signaturePrefix).update(body).digest();
  if (!timingSafeEqual(digest, Buffer.from(signature, "hex"))) {
    return fail(401, "authentication_required", "The signed catalog request could not be verified.");
  }

  try {
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
    catch { return fail(400, "invalid_input", "The signed catalog request is not valid JSON."); }
    const { issuedAt, nonce, legacyId, central, marketId, request: payload } = catalogWriteInput(envelope, raw);
    if (Math.abs(issuedAt - Date.now()) >= maxAgeMs) return fail(401, "expired_request", "The signed catalog request has expired.");
    if (!isMarketSelectable(marketId)) return fail(403, "forbidden", "The requested market is unavailable.");
    const marketplaceOperation = marketplace ? catalogWriteInput(mainAdminMarketplaceInput, payload) : undefined;
    const homepageRead = homepage ? mainAdminHomepageReadInput.safeParse(payload).data : undefined;
    const legacyOperation = homepage || marketplace ? undefined : catalogWriteInput(legacyOperationInput, payload);
    const operation = marketplaceOperation ?? homepageRead ?? legacyOperation ?? catalogWriteInput(command, payload);
    const reading = "read" in operation;
    const media = !reading && (homepage ? operation.action === "homepage.media" : operation.action === "media.upload");
    if (!media && body.byteLength > maxCommandBytes) return fail(413, "body_limit", "Send a catalog request up to 512 KB.");

    const actorId = config.actors.get(legacyId);
    const actor = actorId ? await getDb().staffAccess.findUnique({ where: { userId: actorId }, select: {
      userId: true, active: true, role: true, marketGrants: {
        where: { marketId }, select: { merchandising: true, commercial: true, operations: true },
      },
    } }) : null;
    if (!actor?.active || central !== (actor.role === "OWNER")) {
      return fail(403, "forbidden", "This main admin account has no matching active catalog access.");
    }
    if (!reading && isHomepageCommand(operation.action) !== homepage) return fail(404, "not_found", "This operation is unavailable.");
    const orderPermission = reading || homepage || marketplace ? undefined : mainAdminOrderPermission(operation.action);
    const permission = marketplace ? "owner" : homepage ? "merchandising" : legacyOperation && "read" in legacyOperation ? mainAdminReadPermission(legacyOperation.read) :
      orderPermission ?? catalogCommandPermission(reading ? "" : operation.action);
    if (!central && (permission === "owner" || !actor.marketGrants[0]?.[permission])) {
      return fail(403, "forbidden", "You do not have permission for this catalog operation in the selected market.");
    }
    if (!await consumeQuota(marketplace ? "main-admin.marketplace" : homepage ? "main-admin.homepage" : "main-admin.catalog", actor.userId, 180, 60)) {
      return fail(429, "rate_limited", "Too many catalog requests. Try again in a minute.");
    }
    // With future clock tolerance, a nonce may still be valid for twice the maximum request age.
    if (!await consumeQuota("main-admin.catalog.nonce", nonce.toLowerCase(), 1, 125)) {
      return fail(409, "replayed_request", "This signed catalog request has already been used.");
    }

    if (marketplaceOperation) {
      const writing = "action" in marketplaceOperation;
      if (writing && !await consumeQuota("marketplace.admin.write", actor.userId, 40, 600)) {
        return fail(429, "rate_limited", "Too many Marketplace changes. Try again in a few minutes.");
      }
      const data = await mainAdminMarketplace(actor.userId, marketId, marketplaceOperation);
      if (writing) onMutation?.();
      return Response.json({ data }, { headers: responseHeaders });
    }

    if (homepage) {
      const homepageActor = { id: actor.userId, owner: central, marketId };
      if (homepageRead) return Response.json({ data: await readMainAdminHomepage(homepageActor, homepageRead) }, { headers: responseHeaders });
      if (reading || !isHomepageCommand(operation.action)) return fail(404, "not_found", "This homepage operation is unavailable.");
      if (!await consumeQuota("homepage.write", actor.userId, 40, 600)) {
        return fail(429, "rate_limited", "Too many homepage updates. Try again in a few minutes.");
      }
      const data = await runMainAdminHomepage(homepageActor, operation.action, operation.input);
      if (operation.action === "homepage.publish" || operation.action === "homepage.restore" || operation.action === "homepage.inherit") onHomepagePublication?.();
      return Response.json({ data }, { status: media ? 201 : 200, headers: responseHeaders });
    }

    if (legacyOperation && "read" in legacyOperation) {
      return Response.json({ data: await readMainAdminCatalog(actor.userId, central, marketId, legacyOperation) }, { headers: responseHeaders });
    }
    if (reading) return fail(404, "not_found", "This operation is unavailable.");
    if (media) {
      if (!productMediaUploadAvailable()) return fail(403, "forbidden", "Uploads require verified isolated catalog media storage.");
      if (!await consumeQuota("image.upload", actor.userId, 50, 600)) {
        return fail(429, "rate_limited", "Too many uploads. Try again in a few minutes.");
      }
      return Response.json({ data: await uploadImage(actor.userId, operation.input) }, { status: 201, headers: responseHeaders });
    }
    if (orderPermission) {
      const data = await runMainAdminOrderCommand(actor.userId, marketId, operation.action, operation.input);
      onMutation?.();
      return Response.json({ data }, { headers: responseHeaders });
    }
    if (operation.action === "search.reconcile" || operation.action === "search.rebuild") {
      const mode = operation.action === "search.rebuild" ? "rebuild" : "reconcile";
      const data = await runStaffCatalogSearchMaintenance(actor.userId, marketId, mode, operation.input);
      return Response.json({ data }, { headers: responseHeaders });
    }
    if (!await consumeQuota("catalog.write", `staff:${actor.userId}`, 100, 600)) {
      return fail(429, "rate_limited", "Too many catalog commands. Try again in a few minutes.");
    }
    const data = await runCatalogCommand(operation, { kind: "staff", id: actor.userId, role: actor.role }, async () => marketId);
    onMutation?.();
    return Response.json({ data }, { headers: responseHeaders });
  } catch (error) {
    return catalogErrorResponse(error, "main-admin.catalog");
  }
}
