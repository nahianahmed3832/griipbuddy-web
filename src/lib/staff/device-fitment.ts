import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.ts";
import { deviceLookupKey } from "../catalog/device-fitment.ts";
import { validVariantId } from "../cart/model.ts";
import { getDb } from "../db/client.ts";
import { productIdField, textField } from "./catalog-input.ts";
import { authorize, lockProductEdits, OperationError } from "./operations.ts";
import { CatalogWriteError, catalogWriteInput } from "./operation-error.ts";

const deviceTerm = (max: number) => textField(1, max).refine((term) => /[\p{L}\p{N}]/u.test(deviceLookupKey(term)));
const revisionField = z.number().int().min(0).max(2_147_483_646);
const deviceInput = z.strictObject({
  id: productIdField, brand: deviceTerm(70), name: deviceTerm(100), revision: revisionField.nullable(),
  aliases: z.array(deviceTerm(170)).max(50),
});
const compatibilityInput = z.strictObject({
  productId: productIdField, variantId: z.string().refine(validVariantId), revision: revisionField,
  modelIds: z.array(productIdField).max(100).refine(ids => new Set(ids).size === ids.length, "List each supported model once."),
});

export async function saveDeviceModel(actorId: string, raw: unknown) {
  const { id, brand, name, revision, aliases } = catalogWriteInput(deviceInput, raw);
  const lookupKey = deviceLookupKey(`${brand} ${name}`);
  const approvedAliases = aliases.map(label => ({ label, lookupKey: deviceLookupKey(label) }));
  const keys = [lookupKey, ...approvedAliases.map(alias => alias.lookupKey)];
  if (keys.some(key => key.length > 240) || new Set(keys).size !== keys.length) {
    throw new OperationError("Use distinct canonical and alias lookup terms of at most 240 characters.");
  }

  return getDb().$transaction(async tx => {
    await authorize(tx, actorId, true);
    // Canonical names and approved aliases share a lookup namespace across both tables.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(3100, 9)`;
    const current = await tx.deviceModel.findUnique({ where: { id }, select: { revision: true } });
    if ((current?.revision ?? null) !== revision) throw new CatalogWriteError("conflict", "The device model changed. Reload before editing it.");

    const conflict = await tx.deviceModel.findFirst({
      where: { id: { not: id }, OR: [{ lookupKey: { in: keys } }, { aliases: { some: { lookupKey: { in: keys } } } }] },
      select: { id: true },
    });
    if (conflict) throw new CatalogWriteError("conflict", "A canonical name or approved alias belongs to another device model.");

    const model = await tx.deviceModel.upsert({
      where: { id }, create: { id, brand, name, lookupKey }, update: { brand, name, lookupKey, revision: { increment: 1 } },
      select: { id: true, revision: true },
    });
    if (current) await tx.deviceModelAlias.deleteMany({ where: { modelId: id } });
    if (approvedAliases.length) {
      await tx.deviceModelAlias.createMany({ data: approvedAliases.map(alias => ({ ...alias, modelId: id })) });
    }
    await tx.auditEvent.create({ data: {
      actorId, action: "PRODUCT_SAVED", target: id,
      changes: { kind: "device-model", brand, name, aliases, revision: model.revision },
    } });
    return model;
  });
}

export async function saveVariantCompatibility(actorId: string, raw: unknown) {
  const { productId, variantId, revision, modelIds } = catalogWriteInput(compatibilityInput, raw);

  return getDb().$transaction(async tx => {
    await authorize(tx, actorId, true);
    await lockProductEdits(tx, productId);
    await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR NO KEY UPDATE`;
    const variant = await tx.variant.findFirst({
      where: { id: variantId, productId, archivedAt: null, optionSignature: { not: null },
        product: { foundation: true, publication: { not: "ARCHIVED" } } },
      select: { product: { select: { revision: true } }, compatibility: { select: { modelId: true } } },
    });
    if (!variant) throw new CatalogWriteError("not_found", "Choose a current foundation variant that belongs to this product.");
    if (variant.product.revision !== revision) throw new CatalogWriteError("conflict", "The product changed. Reload its compatibility before editing.");
    const current = variant.compatibility.map(link => link.modelId).sort();
    const desired = [...modelIds].sort();
    if (current.length === desired.length && current.every((id, index) => id === desired[index])) {
      return { productId, variantId, modelIds: desired, revision };
    }
    if (desired.length && await tx.deviceModel.count({ where: { id: { in: desired } } }) !== desired.length) {
      throw new OperationError("Choose approved device models for compatibility.");
    }
    const removed = current.filter(id => !desired.includes(id));
    const added = desired.filter(id => !current.includes(id));
    if (removed.length) await tx.variantCompatibility.deleteMany({ where: { variantId, modelId: { in: removed } } });
    if (added.length) await tx.variantCompatibility.createMany({ data: added.map(modelId => ({ variantId, modelId })) });
    const updated = await tx.product.update({
      where: { id: productId }, data: { revision: { increment: 1 } }, select: { revision: true },
    });
    await tx.auditEvent.create({ data: {
      actorId, action: "PRODUCT_SAVED", target: productId,
      changes: { kind: "variant-compatibility", variantId, before: current, after: desired, revision: updated.revision },
    } });
    return { productId, variantId, modelIds: desired, revision: updated.revision };
  });
}

const deviceSearchInput = z.strictObject({
  q: textField(0, 100).default(""),
  variantId: z.string().refine(validVariantId).optional(),
});
const approvedDeviceSelect = {
  id: true, brand: true, name: true, revision: true,
  aliases: { orderBy: [{ label: "asc" }, { lookupKey: "asc" }], take: 50, select: { label: true } },
} satisfies Prisma.DeviceModelSelect;

export async function searchApprovedDevices(actorId: string, raw: unknown, db = getDb()) {
  await authorize(db, actorId, true);
  const { q, variantId } = catalogWriteInput(deviceSearchInput, raw);
  const query = deviceLookupKey(q);
  const terms = query.split(/ +/).filter(Boolean).slice(0, 8);
  const where = !q ? {} : terms.length ? { OR: [
    { AND: terms.map(term => ({ lookupKey: { contains: term } })) },
    { aliases: { some: { AND: terms.map(term => ({ lookupKey: { contains: term } })) } } },
  ] } : { id: { in: [] } };
  const [matches, linked] = await Promise.all([
    db.deviceModel.findMany({ where, orderBy: [{ brand: "asc" }, { name: "asc" }, { id: "asc" }], take: 21, select: approvedDeviceSelect }),
    variantId ? db.deviceModel.findMany({ where: { compatibility: { some: { variantId } } },
      orderBy: [{ brand: "asc" }, { name: "asc" }, { id: "asc" }], take: 100, select: approvedDeviceSelect }) : [],
  ]);
  return { matches: matches.slice(0, 20), linked, hasMore: matches.length > 20 };
}

export type ApprovedDeviceSearch = Awaited<ReturnType<typeof searchApprovedDevices>>;

export async function readApprovedDevice(actorId: string, rawId: unknown, db = getDb()) {
  await authorize(db, actorId, true);
  const id = catalogWriteInput(productIdField, rawId);
  const device = await db.deviceModel.findUnique({ where: { id }, select: approvedDeviceSelect });
  if (!device) throw new CatalogWriteError("not_found", "The approved device model could not be found.");
  const history = await db.auditEvent.findMany({
    where: { target: id, action: "PRODUCT_SAVED", changes: { path: ["kind"], equals: "device-model" } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 12,
    select: { id: true, createdAt: true, actor: { select: { name: true } } },
  });
  return { device, history };
}
