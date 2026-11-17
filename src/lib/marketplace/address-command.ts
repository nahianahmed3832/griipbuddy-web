import { z } from "zod";
import { marketIds } from "../../config/markets.ts";
import { northAmericanAddressProfiles } from "../../config/address-profiles.ts";
import { checkoutInput, uuid } from "../commerce/checkout-types.ts";
import { paypalCheckoutInput } from "../commerce/paypal-quote.ts";

const label = z.string().trim().min(2).max(60);
const marketId = z.enum(marketIds);

export const bdShippingDetails = checkoutInput.shape.customer;
export const usShippingDetails = paypalCheckoutInput.shape.customer.refine(
  details => northAmericanAddressProfiles.us.regions.some(([code]) => code === details.state),
);
export const caShippingDetails = paypalCheckoutInput.shape.customer.extend({
  country: z.literal("CA"),
  postalCode: z.string().trim().toUpperCase().regex(/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/)
    .transform(value => `${value.slice(0, 3)} ${value.slice(-3)}`),
}).refine(details => northAmericanAddressProfiles.ca.regions.some(([code]) => code === details.state));

export const shippingDetailsSchemas = { district: bdShippingDetails, us: usShippingDetails, ca: caShippingDetails } as const;

export const addressCommands = [
  z.object({ action: z.literal("create-address"), marketId, label, details: z.unknown() }),
  z.object({ action: z.literal("update-address"), marketId, address: uuid, label, details: z.unknown() }),
  z.object({ action: z.literal("remove-address"), marketId, address: uuid }),
  z.object({ action: z.literal("default-address"), marketId, address: uuid }),
] as const;

export type AddressCommand = z.output<typeof addressCommands[number]>;

export type BangladeshAddress = {
  name: string; phone: string; email: string; district: string; locality: string; address: string;
  postalCode: string; landmark: string; alternatePhone: string; instructions: string;
};

type NorthAmericanAddress<Country extends "US" | "CA"> = {
  country: Country; name: string; phone: string; email: string; addressLine1: string;
  addressLine2: string; city: string; state: string; postalCode: string;
};
export type UsAddress = NorthAmericanAddress<"US">;

type AddressRow = { id: string; label: string; isDefault: boolean };
export type SavedAddress =
  | (AddressRow & { marketId: "bd"; details: BangladeshAddress | null })
  | (AddressRow & { marketId: "us"; details: UsAddress | null })
  | (AddressRow & { marketId: "ca"; details: NorthAmericanAddress<"CA"> | null });
