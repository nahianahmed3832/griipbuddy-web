import type { MarketId } from "../../config/markets.ts";
import type { ShopperAddressKind } from "../../generated/prisma/enums.ts";
import { addressMatchesAdapter, checkoutAddressInput } from "../commerce/address.ts";
import { integratedCheckout } from "../commerce/integrated-checkout.ts";
import { deliveryChoices } from "../commerce/orders.ts";
import { getDb } from "../db/client.ts";
import { marketConfiguration } from "../market-config.ts";
import type { MarketplaceCommand } from "./commands.ts";

type AddressCommand = Extract<MarketplaceCommand, { action: "save-address" | "default-address" | "delete-address" }>;

export class AddressBookError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

function readDetails(details: unknown, marketId: MarketId) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return;
  const raw = details as Record<string, unknown>;
  const parsed = checkoutAddressInput.safeParse({ ...raw, email: raw.email ?? "", postalCode: raw.postalCode ?? "" });
  const market = marketConfiguration(marketId);
  if (!parsed.success || !addressMatchesAdapter(market.address.adapter, market.countryCode, parsed.data)) return;
  return parsed.data;
}

export async function addressBook(shopperId: string, marketId: MarketId, kind?: ShopperAddressKind) {
  const rows = await getDb().shopperAddress.findMany({
    where: { shopperId, marketId, ...(kind && { kind }) },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }, { id: "asc" }], take: kind ? 30 : 60,
    select: { id: true, label: true, kind: true, isDefault: true, details: true },
  });
  return rows.map(row => ({ ...row, details: readDetails(row.details, marketId) }));
}

export async function addressDistricts(marketId: MarketId) {
  const market = marketConfiguration(marketId);
  if (market.address.adapter !== "bd-district") return [];
  const choices = integratedCheckout(marketId) ? await deliveryChoices(marketId) : await getDb().deliveryZone.findMany({
    where: { marketId, enabled: true }, orderBy: [{ districtLabel: "asc" }, { district: "asc" }],
    select: { district: true, districtLabel: true },
  });
  return [...new Map(choices.map(choice => [choice.district, { id: choice.district, label: choice.districtLabel }])).values()];
}

export async function writeAddressBook(shopperId: string, marketId: MarketId, command: AddressCommand) {
  if (command.marketId !== undefined && marketId !== command.marketId) {
    throw new AddressBookError("Switch back to this address’s market before making changes.", 409);
  }
  const kind = command.kind ?? "SHIPPING";
  const scope = { shopperId, marketId, kind };
  const db = getDb();
  if (command.action === "save-address") {
    const market = marketConfiguration(marketId);
    if (!addressMatchesAdapter(market.address.adapter, market.countryCode, command.customer) ||
        market.address.adapter === "bd-district" && !(await addressDistricts(marketId)).some(choice => choice.id === command.customer.district)) {
      throw new AddressBookError("Enter a valid address for the selected shopping market.");
    }
    const details = { ...command.customer, country: market.countryCode };
    return db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Shopper" WHERE id = ${shopperId} FOR UPDATE`;
      if (command.address) {
        const updated = await tx.shopperAddress.updateMany({ where: { ...scope, id: command.address },
          data: { label: command.label, details } });
        if (!updated.count) throw new AddressBookError("This address is unavailable.", 404);
        return { id: command.address };
      }
      if (command.operationId) {
        const existing = await tx.shopperAddress.findUnique({ where: { id: command.operationId } });
        if (existing) {
          if (existing.shopperId !== shopperId || existing.marketId !== marketId || existing.kind !== kind) {
            throw new AddressBookError("This address is unavailable.", 404);
          }
          const previous = readDetails(existing.details, marketId);
          if (!previous || existing.label !== command.label ||
            Object.entries(details).some(([key, value]) => previous[key as keyof typeof previous] !== value)) {
            throw new AddressBookError("The saved address differs. Refresh the page before continuing.", 409);
          }
          return { id: existing.id };
        }
      }
      if (await tx.shopperAddress.count({ where: scope }) >= 30) throw new AddressBookError("Remove an old address before saving another.");
      return tx.shopperAddress.create({
        data: { ...scope, ...(command.operationId && { id: command.operationId }), label: command.label, details },
        select: { id: true },
      });
    });
  }
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Shopper" WHERE id = ${shopperId} FOR UPDATE`;
    const eligible = await tx.shopperAddress.findFirst({ where: { ...scope, id: command.address }, select: { details: true } });
    if (!eligible) throw new AddressBookError("This address is unavailable.", 404);
    if (command.action === "delete-address") {
      await tx.shopperAddress.deleteMany({ where: { ...scope, id: command.address } });
      return {};
    }
    if (!readDetails(eligible.details, marketId)) throw new AddressBookError("Edit this address before setting it as default.");
    await tx.shopperAddress.updateMany({ where: { ...scope, isDefault: true, id: { not: command.address } }, data: { isDefault: false } });
    await tx.shopperAddress.updateMany({ where: { ...scope, id: command.address }, data: { isDefault: true } });
    return {};
  });
}
