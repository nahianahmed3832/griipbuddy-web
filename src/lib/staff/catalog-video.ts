import { createHash } from "node:crypto";
import { catalogVideoPrefix, videoUploadLimit } from "../catalog/video.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { authorize, OperationError } from "./operations.ts";

export const catalogVideoContentType = "video/mp4";
export const videoUploadMessage = "Choose an MP4 video up to 4 MB.";

type Box = { type: string; start: number; end: number };

function boxes(data: Buffer, start = 0, end = data.length): Box[] {
  const result: Box[] = [];
  while (start < end) {
    if (start + 8 > end) return [];
    const size = data.readUInt32BE(start);
    const header = size === 1 ? 16 : 8;
    if (start + header > end) return [];
    const length = size === 1 ? Number(data.readBigUInt64BE(start + 8)) : size || end - start;
    if (length < header || length > end - start) return [];
    result.push({ type: data.toString("ascii", start + 4, start + 8), start: start + header, end: start + length });
    start += length;
  }
  return result;
}

export function encodeCatalogVideo(data: Buffer, contentType: string) {
  if (contentType !== catalogVideoContentType || data.length === 0 || data.length > videoUploadLimit) {
    throw new OperationError(videoUploadMessage);
  }
  const root = boxes(data);
  const header = root[0];
  const movie = root.find(({ type }) => type === "moov");
  const videoTrack = movie && boxes(data, movie.start, movie.end).some(track =>
    track.type === "trak" && boxes(data, track.start, track.end).some(media =>
      media.type === "mdia" && boxes(data, media.start, media.end).some(handler =>
        handler.type === "hdlr" && handler.start + 12 <= handler.end &&
        data.toString("ascii", handler.start + 8, handler.start + 12) === "vide")));
  if (header?.type !== "ftyp" || header.end - header.start < 8 || !videoTrack ||
    !root.some(({ type, start, end }) => type === "mdat" && end > start)) {
    throw new OperationError("The file could not be read as an MP4 video.");
  }
  const id = createHash("sha256").update(data).digest("hex");
  return { id, data: new Uint8Array(data), contentType: catalogVideoContentType };
}

export async function storeCatalogVideo(actorId: string, data: Buffer, contentType: string) {
  const video = encodeCatalogVideo(data, contentType);
  const db = getDb();
  await db.$transaction(async tx => {
    await authorize(tx, actorId, true);
    await tx.catalogMedia.upsert({ where: { id: video.id }, update: {}, create: video });
  });
  return catalogVideoPrefix + video.id;
}

export async function missingVideo(db: DbReader, paths: readonly (string | null | undefined)[]) {
  const ids = [...new Set(paths.flatMap(path => path ? [path.slice(catalogVideoPrefix.length)] : []))];
  return ids.length > 0 && await db.catalogMedia.count({
    where: { id: { in: ids }, contentType: catalogVideoContentType },
  }) !== ids.length;
}
