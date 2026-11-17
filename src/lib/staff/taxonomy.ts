import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import { catalogImage, productIdField, slugField, textField, validationMessage } from "./catalog-input.ts";
import { missingImage } from "./catalog-media.ts";
import { authorize, OperationError } from "./operations.ts";

const base = {
  id: productIdField.refine((id) => id !== "new", "Choose an ID other than new."), slug: slugField, name: textField(2, 100),
  description: textField(0, 1200), position: z.number().int().min(0).max(9999),
};
const taxonomyInput = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("department"), shortName: textField(2, 32), image: catalogImage, parentId: productIdField.nullable().optional() }),
  z.object({ ...base, kind: z.literal("collection"), image: catalogImage.optional(), selection: z.enum(["CURATED", "NEW", "FEATURED"]) }),
]);

export async function saveTaxonomy(actorId: string, raw: unknown, existingId: string | null) {
  const parsed = taxonomyInput.safeParse(raw);
  if (!parsed.success) throw new OperationError(validationMessage(parsed.error));
  const value = parsed.data;
  if (existingId !== null && existingId !== value.id) throw new OperationError("An existing ID cannot change.");
  try {
    await getDb().$transaction(async (tx) => {
      await authorize(tx, actorId, true);
      const fields = { slug: value.slug, name: value.name, description: value.description, position: value.position };
      if (value.image && await missingImage(tx, [value.image.src])) throw new OperationError("The image path does not exist.");
      if (value.kind === "department") {
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(3100, 8)`;
        if (value.parentId) {
          const rows = await tx.department.findMany({ select: { id: true, parentId: true } });
          const categories = new Map(rows.map((row) => [row.id, row.parentId]));
          if (!categories.has(value.parentId)) throw new OperationError("Choose an existing parent category.");
          const seen = new Set([value.id]);
          let ancestor = value.parentId;
          while (ancestor) {
            if (seen.has(ancestor)) throw new OperationError("A category cannot be placed under itself or its descendants.");
            seen.add(ancestor);
            ancestor = categories.get(ancestor) ?? "";
          }
        }
        const data = { ...fields, shortName: value.shortName, imageSrc: value.image.src, imageAlt: value.image.alt, parentId: value.parentId };
        if (existingId) await tx.department.update({ where: { id: existingId }, data });
        else await tx.department.create({ data: { ...data, id: value.id } });
      } else {
        const data = { ...fields, selection: value.selection, imageSrc: value.image?.src ?? null, imageAlt: value.image?.alt ?? null };
        if (existingId) await tx.collection.update({ where: { id: existingId }, data });
        else await tx.collection.create({ data: { ...data, id: value.id } });
      }
      await tx.auditEvent.create({
        data: { actorId, action: "TAXONOMY_SAVED", target: value.id, changes: {
          kind: value.kind, slug: value.slug, ...(value.kind === "department" && value.parentId !== undefined && { parentId: value.parentId }),
        } },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new OperationError("That ID or URL slug is already in use.");
    throw error;
  }
}
