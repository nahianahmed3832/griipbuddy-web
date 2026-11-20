import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { readBody } from "../db/http.ts";
import { developmentAcceptanceDatabase, localDatabase } from "../db/local.ts";

// Steadfast observation codes already recognized by the recovered carrier adapter.
// Approval-pending and partial outcomes never assert completed delivery here.
const steadfastStatuses = {
  pending: "PREPARING",
  in_review: "PREPARING",
  dispatched: "HANDED_TO_CARRIER",
  in_transit: "IN_TRANSIT",
  customs: "IN_TRANSIT",
  out_for_delivery: "OUT_FOR_DELIVERY",
  delivered: "DELIVERED",
  delivered_approval_pending: "IN_TRANSIT",
  partial_delivered: "DELIVERY_EXCEPTION",
  cancelled: "DELIVERY_EXCEPTION",
  cancelled_approval_pending: "DELIVERY_EXCEPTION",
  unknown: "DELIVERY_EXCEPTION",
  hold: "DELIVERY_EXCEPTION",
  lost: "DELIVERY_EXCEPTION",
  damaged: "DELIVERY_EXCEPTION",
  failed_delivery: "DELIVERY_EXCEPTION",
  returned: "RETURNED",
  delayed: "DELIVERY_EXCEPTION",
} as const;

const timestampPattern = /^\d{10}$/;
const signaturePattern = /^[0-9a-f]{64}$/;
const signatureWindowSeconds = 300;
const relayBodyLimit = 16_384;
const relayTrackingReference = z.string().min(1).max(80).regex(/^[A-Za-z0-9-]+$/);
const relayIdentity = {
  parcelId: z.uuid(),
  carrier: z.literal("steadfast"),
  trackingReference: relayTrackingReference,
  eventId: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  occurredAt: z.iso.datetime({ offset: true }),
};
const relayInput = z.union([
  z.strictObject({ ...relayIdentity, code: z.enum(Object.keys(steadfastStatuses) as (keyof typeof steadfastStatuses)[]),
    estimatedDeliveryAt: z.iso.datetime({ offset: true }).optional() }),
  z.strictObject({ ...relayIdentity, error: z.enum(["UNAVAILABLE", "NOT_FOUND", "RATE_LIMITED"]) }),
]);

type RelayObservationIdentity = Omit<z.infer<z.ZodObject<typeof relayIdentity>>, "occurredAt"> & { occurredAt: Date };
export type CarrierTrackingObservation = RelayObservationIdentity & ({
  status: (typeof steadfastStatuses)[keyof typeof steadfastStatuses];
  providerCode: keyof typeof steadfastStatuses;
  estimatedDeliveryAt?: Date;
} | { error: "UNAVAILABLE" | "NOT_FOUND" | "RATE_LIMITED" });

type RelayResult = { observation: CarrierTrackingObservation } | { errorStatus: 400 | 401 | 404 | 413 | 415 | 422 };

function parcelTrackingRelaySecret() {
  if (localDatabase() !== "griipbuddy_test" && !developmentAcceptanceDatabase()) return null;
  const secret = process.env.GRIIP_PARCEL_TRACKING_WEBHOOK_SECRET;
  return secret && Buffer.byteLength(secret) >= 32 ? secret : null;
}

export function carrierTrackingRelayEnabled() {
  return parcelTrackingRelaySecret() !== null;
}

export function parcelTrackingRelayProvider(carrier: string | null): "steadfast" | null {
  const label = carrier?.trim().toLowerCase();
  return label === "steadfast" || label === "steadfast courier" ? "steadfast" : null;
}

export function supportsParcelTrackingRelay(carrier: string | null) {
  return parcelTrackingRelayProvider(carrier) !== null;
}

export function supportsParcelTrackingRelayReference(reference: string | null) {
  return relayTrackingReference.safeParse(reference).success;
}

export async function readCarrierTrackingRelay(request: Request, now = Date.now()): Promise<RelayResult> {
  const secret = parcelTrackingRelaySecret();
  if (!secret) return { errorStatus: 404 };
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json" ||
      request.headers.has("content-encoding")) return { errorStatus: 415 };

  const timestamp = request.headers.get("x-shipping-timestamp") ?? "";
  const signature = request.headers.get("x-shipping-signature") ?? "";
  if (!timestampPattern.test(timestamp) || !signaturePattern.test(signature) ||
      Math.abs(Math.floor(now / 1000) - Number(timestamp)) > signatureWindowSeconds ||
      request.headers.has("origin") || request.headers.has("sec-fetch-site")) return { errorStatus: 401 };

  const body = await readBody(request, relayBodyLimit);
  if (!body) return { errorStatus: 413 };
  // The recovered shipping webhook uses an HMAC of the timestamp, a dot, and the unparsed bytes.
  const digest = createHmac("sha256", secret).update(timestamp + ".").update(body).digest();
  if (!timingSafeEqual(digest, Buffer.from(signature, "hex"))) return { errorStatus: 401 };
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { return { errorStatus: 400 }; }

  const parsed = relayInput.safeParse(raw);
  if (!parsed.success) return { errorStatus: 422 };
  const event = parsed.data;
  const occurredAt = new Date(event.occurredAt);
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > now + signatureWindowSeconds * 1000) return { errorStatus: 422 };
  if ("error" in event) return { observation: { ...event, occurredAt } };
  const { code, estimatedDeliveryAt, ...identity } = event;
  const estimated = estimatedDeliveryAt ? new Date(estimatedDeliveryAt) : undefined;
  if (estimated && (!Number.isFinite(estimated.getTime()) || estimated < occurredAt)) return { errorStatus: 422 };
  return { observation: { ...identity, status: steadfastStatuses[code], providerCode: code, occurredAt,
    ...(estimated && { estimatedDeliveryAt: estimated }) } };
}
