import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { bangladeshTrackingLabels, nextBangladeshTrackingStatuses } from "../commerce/bangladesh-shipment-status.ts";
import { orderHasAdapter } from "../commerce/market-commerce.ts";
import { canEditParcelReference, canRecordParcelException, dispatchOrderParcel, orderParcelSplitsPaused, receiveRefusedOrderParcel, recordOrderParcelException,
  recordOrderParcelPreparation, recordOrderParcelTracking, splitOrderParcel, updateOrderParcelReference } from "../commerce/order-parcels.ts";
import { parcelTrackingRelayReadiness, refreshOrderParcelTracking } from "../commerce/order-parcel-tracking.ts";
import { canAdvanceParcelTracking, currentParcelTrackingStatus, nextOrderParcelStatuses, normalizedParcelEventStatus,
  orderParcelStatusLabels, parcelItemsToShip, parcelPreparationLabels, parcelTrackingStatusLabels, type OrderParcelStaffTracking } from "../commerce/parcel-tracking.ts";
import { purchasedOptions } from "../commerce/purchased-options.ts";
import { getDb } from "../db/client.ts";
import { marketConfiguration } from "../market-config.ts";
import { caseActorRole, caseCommand, ownerCaseTransitions } from "../marketplace/case-policy.ts";
import { casesForStaffOrder, executeOrderCase, listOrderCases, OrderCaseError, staffOrderCase } from "../marketplace/cases.ts";
import { storeShop } from "../marketplace/constants.ts";
import { staffSellerPreparation } from "../marketplace/seller-orders.ts";
import { sellerPreparationLabels } from "../marketplace/seller-preparation.ts";
import { marketplaceMode } from "../release-config.ts";
import { CatalogWriteError, catalogWriteInput, OperationError } from "./operation-error.ts";
import { advanceFulfillment, cancelOrder, collectCash, listStaffOrders, queueFilter, queueFilters, recordBangladeshTracking, staffOrder } from "./operations.ts";
import { staffOrderWorkspaceState, staffQueueStatus } from "./order-workspace-state.ts";

const page = z.int().min(1).max(10_000).optional();
const queues = queueFilters.map(([key]) => key);
export const mainAdminOrderReads = [
  z.strictObject({ read: z.literal("orders"), queue: z.enum(queues).optional(), page }),
  z.strictObject({ read: z.literal("order"), id: z.uuid() }),
  z.strictObject({ read: z.literal("order-cases"), closed: z.boolean().optional(), page }),
  z.strictObject({ read: z.literal("order-case"), id: z.uuid() }),
] as const;
type OrderRead = z.infer<(typeof mainAdminOrderReads)[number]>;

const orderPermissions = {
  "order.advance": "operations", "order.tracking": "operations", "order.parcel.dispatch": "operations",
  "order.parcel.tracking": "operations", "order.parcel.receive": "operations", "order.parcel.prepare": "operations",
  "order.parcel.split": "operations", "order.parcel.reference": "operations", "order.parcel.exception": "operations", "order.parcel.refresh": "operations",
  "order.case": "owner", "order.cancel": "owner", "order.collect": "owner",
} as const;
type OrderAction = keyof typeof orderPermissions;

export function mainAdminOrderPermission(action: string) {
  if (Object.hasOwn(orderPermissions, action)) return orderPermissions[action as OrderAction];
}

export const mainAdminOrderCommandInput = z.strictObject({
  action: z.enum(Object.keys(orderPermissions) as OrderAction[]), input: z.record(z.string(), z.unknown()),
});

function missingOrder(): never {
  throw new CatalogWriteError("not_found", "This Marketplace order is unavailable in the selected market.");
}

function requireCases() {
  if (!marketplaceMode()) throw new CatalogWriteError("not_found", "Marketplace order cases are unavailable.");
}

function packingLine(line: { id: string; variantId: string; sku: string; productName: string; variantName: string;
  quantity: number; unitPriceMinor: number; personalization: string | null; optionsSnapshot?: unknown }) {
  return { id: line.id, variantId: line.variantId, sku: line.sku, productName: line.productName,
    options: purchasedOptions(line), quantity: line.quantity, unitPriceMinor: line.unitPriceMinor, personalization: line.personalization };
}

function parcelTimeline(parcel: OrderParcelStaffTracking, actors: ReadonlyMap<string, string>, owner: boolean) {
  return [
    ...parcel.events.map(event => ({ id: `operational:${event.status}`, status: parcelTrackingStatusLabels[normalizedParcelEventStatus(event.status)],
      source: event.actorId ? parcel.source ?? "MANUAL" : "SYSTEM", actor: event.actorId ? actors.get(event.actorId) ?? event.actorId : null,
      reason: event.reason, occurredAt: event.recordedAt, recordedAt: event.recordedAt, evidence: owner ? event.evidence : null })),
    ...parcel.trackingObservations.map(event => ({ id: event.id,
      status: event.status ? parcelTrackingStatusLabels[event.status] : event.error ? "Carrier synchronization issue" : "Tracking reference updated",
      source: event.source, actor: event.actorId ? actors.get(event.actorId) ?? event.actorId : null,
      reason: event.reason, occurredAt: event.occurredAt, recordedAt: event.recordedAt, evidence: null, applied: event.applied })),
    ...parcel.preparationEvents.map(event => ({ id: `preparation:${event.operationId}`, status: parcelPreparationLabels[event.state],
      source: "MANUAL", actor: actors.get(event.actorId) ?? event.actorId, reason: null, evidence: null,
      occurredAt: event.recordedAt, recordedAt: event.recordedAt })),
  ].sort((a, b) => +a.occurredAt - +b.occurredAt || +a.recordedAt - +b.recordedAt || a.id.localeCompare(b.id));
}

async function readOrder(actorId: string, owner: boolean, marketId: MarketId, id: string) {
  const order = await staffOrder(actorId, id, marketId);
  if (!order?.payment) missingOrder();
  const state = staffOrderWorkspaceState(order, order.payment);
  const material = order.items.map(packingLine);
  const linesById = new Map(material.map(line => [line.id, line]));
  const canHandOff = orderHasAdapter(order, "fulfillment", "manual");
  const canReceive = orderHasAdapter(order, "returns", "manual");
  const market = marketConfiguration(marketId);
  const { name: marketName, locale, timeZone } = market;
  const shopIds = [...new Set(order.items.flatMap(item => item.marketplaceShopId && item.marketplaceShopId !== storeShop.id ? [item.marketplaceShopId] : []))];
  const actorIds = [...new Set([
    ...order.parcels.flatMap(parcel => [...parcel.events, ...parcel.trackingObservations, ...parcel.preparationEvents].flatMap(event => event.actorId ?? [])),
    ...(state.shipment?.events.map(event => event.actorId) ?? []),
  ])];
  const [shops, cases, parcelActors] = await Promise.all([
    marketplaceMode() && shopIds.length ? staffSellerPreparation(id, shopIds) : [],
    owner && marketplaceMode() ? casesForStaffOrder(actorId, order.id) : [],
    actorIds.length ? getDb().user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [],
  ]);
  const actors = new Map(parcelActors.map(actor => [actor.id, actor.name]));
  const canSplitParcels = !orderParcelSplitsPaused() && state.active;
  return {
    id: order.id, reference: order.reference, status: order.status, createdAt: order.createdAt, currency: order.currency, marketName, locale, timeZone,
    fulfillment: state.fulfillment, totalMinor: order.totalMinor, subtotalMinor: order.subtotalMinor, discountMinor: order.discountMinor,
    deliveryMinor: order.deliveryMinor, taxMinor: order.taxMinor, payment: { method: order.payment.method, status: order.payment.status, dueMinor: state.due },
    shipping: { name: order.customerName, address: order.address, locality: order.locality, district: order.districtLabel,
      postalCode: order.postalCode, phone: order.phone, service: order.deliveryLabel },
    lines: material, packable: state.canPack, pendingCancellation: Boolean(state.pendingCancellation), requiresCodReview: state.requiresCodReview,
    next: !state.pendingCancellation || state.next !== "SHIPPED" ? state.next : undefined,
    canCancel: owner && state.active && state.awaiting && !state.pendingCancellation && state.canCancel,
    canCollect: owner && state.active && state.cod && state.awaiting && order.fulfillmentStatus === "DELIVERED"
      && state.parcels.every(parcel => parcel.status === "DELIVERED"),
    shipment: state.shipment && { status: state.shipment.status, carrier: state.shipment.carrier, reference: state.shipment.trackingReference,
      next: state.active ? nextBangladeshTrackingStatuses(state.shipment.status).filter(status => owner || status !== "REFUSED") : [],
      evidenceRequired: state.shipment.source !== "DEV_SIMULATOR", statusUpdatedAt: state.shipment.statusUpdatedAt,
      events: state.shipment.events.map(event => ({ id: event.status, status: bangladeshTrackingLabels[event.status], source: state.shipment?.source,
        actor: actors.get(event.actorId) ?? event.actorId, occurredAt: event.recordedAt, recordedAt: event.recordedAt,
        evidence: owner ? event.evidence : null, reason: null })) },
    parcels: state.parcels.map(parcel => ({ id: parcel.id, warehouse: parcel.locationName, status: orderParcelStatusLabels[parcel.status],
      carrier: parcel.carrier, reference: parcel.trackingReference, disposition: parcel.returnDisposition,
      preparationState: parcel.preparationState,
      preparable: state.canPack && !state.pendingCancellation && (!state.cod || state.awaiting) && parcel.status === "PLANNED"
        && (parcel.preparationState === "PENDING" || parcel.preparationState === "PICKED"),
      trackingStatus: currentParcelTrackingStatus(parcel), statusUpdatedAt: parcel.trackingOccurredAt ?? parcel.statusUpdatedAt,
      estimatedDeliveryAt: parcel.estimatedDeliveryAt, lastSyncedAt: parcel.trackingSyncedAt, lastSyncAttemptAt: parcel.trackingAttemptAt,
      syncError: parcel.trackingSyncError, trackingRevision: parcel.trackingRevision,
      ...parcelTrackingRelayReadiness(parcel, order.measurementTest === true && orderHasAdapter(order, "fulfillment", "steadfast"), marketId),
      splittable: canSplitParcels && parcel.status === "PLANNED" && (parcel.preparationState === null || parcel.preparationState === "PENDING")
        && parcelItemsToShip(parcel.items).reduce((total, line) => total + line.quantity, 0) > 1,
      editableReference: state.active && canEditParcelReference(parcel), canRecordException: state.active && canRecordParcelException(parcel),
      dispatchable: state.canDispatch && canHandOff && parcel.status === "PLANNED" && (parcel.preparationState === null || parcel.preparationState === "PACKED"),
      receivable: state.active && canReceive && parcel.status === "REFUSED",
      next: state.active ? nextOrderParcelStatuses(parcel.status).filter(status => status === "REFUSED" ? owner
        : canAdvanceParcelTracking(currentParcelTrackingStatus(parcel), normalizedParcelEventStatus(status))) : [],
      evidenceRequired: parcel.source !== "DEV_SIMULATOR", events: parcelTimeline(parcel, actors, owner),
      lines: parcelItemsToShip(parcel.items).flatMap(line => {
        const item = linesById.get(line.orderItem.id);
        return item ? [{ ...item, quantity: line.quantity }] : [];
      }),
    })),
    events: order.events.map(event => ({ id: event.id, status: event.status, kind: event.type, date: event.createdAt, actor: event.actor?.name ?? null })),
    cases, sellers: shops.map(shop => ({ id: shop.id, name: shop.name,
      preparation: shop.fulfillments[0] ? sellerPreparationLabels[shop.fulfillments[0].status] : "Awaiting preparation",
      updatedAt: shop.fulfillments[0]?.updatedAt ?? null })),
  };
}

async function readCase(actorId: string, marketId: MarketId, id: string) {
  requireCases();
  const row = await staffOrderCase(actorId, id, marketId);
  if (!row) throw new CatalogWriteError("not_found", "This order case is unavailable in the selected market.");
  const { kind, status, revision, order, returnLines, events, returnDisposition, pickupAt, pickupReference,
    replacementTrackingReference, refundAmountMinor, refundLimitMinor, requiresCancellationRefund, canApproveCancellation,
    canProcessRefund, cancellationAppliedAt, refund } = row;
  const { locale, timeZone } = marketConfiguration(marketId);
  const inspectable = returnLines.length > 0 && (kind === "RETURN" || kind === "EXCHANGE");
  const refundable = refundLimitMinor > 0 && (inspectable && status === "RETURN_RECEIVED" ||
    kind === "CANCEL" && status === "CANCELLATION_APPROVED" || requiresCancellationRefund);
  const review = ownerCaseTransitions(kind, status, returnLines.length > 0)
    .filter(next => status !== "REFUND_APPROVED" || next !== "RESOLVED" || refund?.state === "CONFIRMED");
  return { id: row.id, kind, status, revision, order: { id: order.id, reference: order.reference, currency: order.currency, paymentMethod: order.payment?.method ?? null }, locale, timeZone,
    events, refund, cancellationAppliedAt, returnDisposition, pickupAt, pickupReference, replacementTrackingReference, refundAmountMinor, refundLimitMinor,
    returnLines: returnLines.map(({ quantity, orderItem, replacementVariantName }) => ({ ...packingLine(orderItem), quantity, replacementVariantName })),
    allowed: { review, cancel: canApproveCancellation, refund: refundable, processRefund: canProcessRefund,
      inspection: inspectable && (status === "RETURN_APPROVED" || status === "PICKUP_SCHEDULED"),
      replacement: kind === "EXCHANGE" && status === "RETURN_RECEIVED", requiresCancellationRefund },
  };
}

export function readMainAdminOrders(actorId: string, owner: boolean, marketId: MarketId, request: OrderRead, marketplaceChannel = false) {
  switch (request.read) {
    case "orders": return listStaffOrders(actorId, queueFilter(request.queue), request.page ?? 1, marketId).then(({ rows, hasNext }) => ({
      rows: rows.map(row => ({
        ...(marketplaceChannel ? row : { id: row.id, reference: row.reference, createdAt: row.createdAt,
          districtLabel: row.districtLabel, currency: row.currency, totalMinor: row.totalMinor, payment: row.payment, _count: row._count }),
        ...staffQueueStatus(row),
      })), hasNext,
    }));
    case "order": return readOrder(actorId, owner, marketId, request.id);
    case "order-cases":
      requireCases();
      return listOrderCases(actorId, request.closed ?? false, request.page ?? 1, marketId);
    case "order-case": return readCase(actorId, marketId, request.id);
  }
}

const orderId = z.object({ orderId: z.uuid() });
const parcelId = orderId.extend({ parcelId: z.uuid() });
const review = orderId.extend({ confirmed: z.literal(true) });

async function runCase(actorId: string, marketId: MarketId, input: unknown) {
  requireCases();
  const command = catalogWriteInput(caseCommand, input);
  if (caseActorRole(command) !== "owner" || !("caseId" in command)) {
    throw new CatalogWriteError("forbidden", "Open or withdraw a case from the shopper's order.");
  }
  if (!await getDb().orderCase.findFirst({ where: { id: command.caseId, order: { marketId } }, select: { id: true } })) {
    throw new CatalogWriteError("not_found", "This order case is unavailable in the selected market.");
  }
  try {
    return await executeOrderCase({ id: actorId, role: "owner" }, command);
  } catch (error) {
    if (!(error instanceof OrderCaseError)) throw error;
    switch (error.status) {
      case 409: throw new CatalogWriteError("conflict", error.message);
      case 403: throw new CatalogWriteError("forbidden", error.message);
      case 404: throw new CatalogWriteError("not_found", error.message);
      default: throw new OperationError(error.message);
    }
  }
}

export async function runMainAdminOrderCommand(actorId: string, marketId: MarketId, action: string, input: Record<string, unknown>) {
  if (action === "order.case") return runCase(actorId, marketId, input);
  const { orderId: id } = catalogWriteInput(orderId, input);
  if (!await getDb().order.findFirst({ where: { id, marketId }, select: { id: true } })) missingOrder();
  switch (action) {
    case "order.advance": await advanceFulfillment(actorId, id, { ...input, simulate: false }); break;
    case "order.tracking": await recordBangladeshTracking(actorId, id, input); break;
    case "order.parcel.dispatch": await dispatchOrderParcel(actorId, id, catalogWriteInput(parcelId, input).parcelId, { ...input, simulate: false }); break;
    case "order.parcel.tracking": await recordOrderParcelTracking(actorId, id, catalogWriteInput(parcelId, input).parcelId, input); break;
    case "order.parcel.prepare": return { orderId: id, saved: true,
      ...await recordOrderParcelPreparation(actorId, id, catalogWriteInput(parcelId, input).parcelId, input) };
    case "order.parcel.split": return { orderId: id, saved: true, ...await splitOrderParcel(actorId, id, catalogWriteInput(parcelId, input).parcelId, input) };
    case "order.parcel.reference": await updateOrderParcelReference(actorId, id, catalogWriteInput(parcelId, input).parcelId, input); break;
    case "order.parcel.exception": await recordOrderParcelException(actorId, id, catalogWriteInput(parcelId, input).parcelId, input); break;
    case "order.parcel.refresh": return { orderId: id, ...await refreshOrderParcelTracking(actorId, id, catalogWriteInput(parcelId, input).parcelId) };
    case "order.parcel.receive": {
      catalogWriteInput(review, input);
      await receiveRefusedOrderParcel(actorId, id, catalogWriteInput(parcelId, input).parcelId, input);
      break;
    }
    case "order.cancel": catalogWriteInput(review, input); await cancelOrder(actorId, id); break;
    case "order.collect": catalogWriteInput(review, input); await collectCash(actorId, id); break;
    default: throw new CatalogWriteError("invalid_input", "Choose a supported Marketplace order action.");
  }
  return { orderId: id, saved: true };
}
