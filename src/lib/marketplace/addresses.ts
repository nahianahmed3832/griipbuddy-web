import { markets, type MarketId } from "../../config/markets.ts";
import { integratedCheckout, recoveredDeliveryChoices } from "../commerce/integrated-checkout.ts";
import { getDb } from "../db/client.ts";
import { shippingDetailsSchemas, type AddressCommand, type SavedAddress } from "./address-command.ts";

export class AddressError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const addressLimit = 30;
const addressFields = { id: true, marketId: true, label: true, details: true, isDefault: true } as const;

export async function addressDistricts() {
  const rows = integratedCheckout() ? await recoveredDeliveryChoices("bd") : await getDb().deliveryZone.findMany({
    where: { marketId: "bd", enabled: true, chargeMinor: { not: null } },
    orderBy: { districtLabel: "asc" },
    select: { district: true, districtLabel: true },
  });
  return [...new Map(rows.map(({ district, districtLabel }) => [district, { id: district, label: districtLabel }])).values()];
}

export async function savedAddresses(shopperId: string, marketId: MarketId): Promise<SavedAddress[]> {
  const rows = await getDb().shopperAddress.findMany({
    where: { shopperId, marketId }, select: addressFields,
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }, { id: "desc" }], take: addressLimit,
  });
  return rows.map(row => {
    const { id, label, isDefault } = row;
    const value = row.details && typeof row.details === "object" && !Array.isArray(row.details) ? row.details : {};
    if (row.marketId !== "bd") {
      const marketId = row.marketId;
      const parsed = shippingDetailsSchemas[markets[marketId].addressProfile].safeParse({ ...value, email: value.email ?? "", addressLine2: value.addressLine2 ?? "" });
      if (parsed.success && parsed.data.country === "US" && marketId === "us") {
        return { id, label, isDefault, marketId, details: { ...parsed.data, email: parsed.data.email ?? "", addressLine2: parsed.data.addressLine2 ?? "" } };
      }
      if (parsed.success && parsed.data.country === "CA" && marketId === "ca") {
        return { id, label, isDefault, marketId, details: { ...parsed.data, email: parsed.data.email ?? "", addressLine2: parsed.data.addressLine2 ?? "" } };
      }
      return { id, label, isDefault, marketId, details: null };
    }
    const parsed = shippingDetailsSchemas.district.safeParse({ ...value, email: value.email ?? "", postalCode: value.postalCode ?? "" });
    return { id, label, isDefault, marketId: "bd", details: parsed.success ? {
      ...parsed.data, email: parsed.data.email ?? "", postalCode: parsed.data.postalCode ?? "",
      landmark: parsed.data.landmark ?? "", alternatePhone: parsed.data.alternatePhone ?? "", instructions: parsed.data.instructions ?? "",
    } : null };
  });
}

export async function changeSavedAddress(shopperId: string, command: AddressCommand) {
  const { marketId } = command;
  const where = { shopperId, marketId };
  const details = "details" in command
    ? shippingDetailsSchemas[markets[marketId].addressProfile].safeParse(command.details)
    : null;
  if (details && !details.success) throw new AddressError("Check the recipient and delivery address.", 422);
  const district = details?.success && "district" in details.data ? details.data.district : null;
  if (district && !(await addressDistricts()).some(item => item.id === district)) {
    throw new AddressError("Choose a district currently served by the storefront.", 422);
  }

  return getDb().$transaction(async tx => {
    // Serialize address writes, including switching the default and replacing a deleted default.
    const owner = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Shopper" WHERE id = ${shopperId} FOR UPDATE`;
    if (!owner.length) throw new AddressError("Sign in to manage your addresses.", 401);
    const event = (action: string) => tx.shopperAccountEvent.create({ data: { shopperId, marketId, action } });
    if (command.action === "create-address" && details?.success) {
      // Strip empty optional values so retries compare the same normalized JSON in PostgreSQL.
      const data = Object.fromEntries(Object.entries(details.data).filter(([, value]) => value !== undefined));
      const existing = await tx.shopperAddress.findFirst({ where: { ...where, details: { equals: data } }, select: { id: true } });
      if (existing) return existing;
      const count = await tx.shopperAddress.count({ where });
      if (count >= addressLimit) throw new AddressError("Remove a saved address before adding another.", 422);
      const row = await tx.shopperAddress.create({ data: { ...where, label: command.label, details: data, isDefault: count === 0 },
        select: { id: true } });
      await event("address_created");
      return row;
    }
    if (!("address" in command)) throw new AddressError("Check the recipient and delivery address.", 422);
    const row = await tx.shopperAddress.findFirst({ where: { ...where, id: command.address }, select: { id: true, isDefault: true } });
    if (!row) throw new AddressError("We couldn’t find that saved address.", 404);
    if (command.action === "update-address" && details?.success) {
      const data = Object.fromEntries(Object.entries(details.data).filter(([, value]) => value !== undefined));
      await tx.shopperAddress.update({ where: { id: row.id }, data: { label: command.label, details: data } });
      await event("address_updated");
    }
    if (command.action === "remove-address") {
      await tx.shopperAddress.delete({ where: { id: row.id } });
      if (row.isDefault) {
        const next = await tx.shopperAddress.findFirst({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
        if (next) await tx.shopperAddress.update({ where: { id: next.id }, data: { isDefault: true } });
      }
      await event("address_deleted");
    }
    if (command.action === "default-address" && !row.isDefault) {
      await tx.shopperAddress.updateMany({ where: { ...where, isDefault: true }, data: { isDefault: false } });
      await tx.shopperAddress.update({ where: { id: row.id }, data: { isDefault: true } });
      await event("address_default_changed");
    }
    return { id: row.id };
  });
}
