import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { getDb, type DbReader } from "../db/client.ts";
import { catalogImage } from "./catalog-input.ts";
import { authorize, OperationError } from "./operations.ts";

export const uploadLimit = 4 * 1024 * 1024;
const types = new Map([["image/jpeg", "jpeg"], ["image/png", "png"], ["image/webp", "webp"]]);

export async function encodeCatalogImage(data: Buffer, contentType: string) {
  const format = types.get(contentType);
  if (!format || data.length < 1 || data.length > uploadLimit) {
    throw new OperationError("Upload a JPEG, PNG, or WebP image up to 4 MB.");
  }
  let encoded: Buffer;
  try {
    const image = sharp(data, { limitInputPixels: 16_000_000, failOn: "warning" });
    const metadata = await image.metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1) throw new Error("Unsupported image");
    encoded = await image.autoOrient().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
  } catch {
    throw new OperationError("The image could not be read. Use a still JPEG, PNG, or WebP under 16 megapixels.");
  }
  if (encoded.length > uploadLimit) throw new OperationError("The processed image is too large. Use a smaller image.");
  const id = createHash("sha256").update(encoded).digest("hex");
  return { id, data: new Uint8Array(encoded) };
}

export async function storeCatalogImage(actorId: string, data: Buffer, contentType: string) {
  const db = getDb();
  await authorize(db, actorId, true);
  const image = await encodeCatalogImage(data, contentType);
  await db.$transaction(async (tx) => {
    await authorize(tx, actorId, true);
    await tx.catalogMedia.upsert({ where: { id: image.id }, update: {}, create: image });
  });
  return `/media/${image.id}`;
}

export async function missingImage(db: DbReader, paths: Iterable<string>) {
  for (const src of new Set(paths)) {
    if (!catalogImage.shape.src.safeParse(src).success) return src;
    if (src.startsWith("/media/")) {
      if (!await db.catalogMedia.findUnique({ where: { id: src.slice(7), contentType: "image/webp" }, select: { id: true } })) return src;
    } else {
      try {
        await access(join(process.cwd(), "public", src.slice(1)));
      } catch {
        return src;
      }
    }
  }
  return null;
}
