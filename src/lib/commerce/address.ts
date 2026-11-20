import { z } from "zod";

export const addressText = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine(value => [...value].every(char => char >= " " && char !== "\u007f"));

const optionalEmail = z.union([z.email().max(254), z.literal("")]).optional().transform(value => value?.toLowerCase() || null);
const bdPhone = z.string().max(28).transform(value => value.trim().replace(/[\s()-]/g, ""))
  .pipe(z.string().regex(/^(?:\+?880|0)1[3-9]\d{8}$/))
  .transform(value => `+880${value.slice(-10)}`);
export const usPhone = z.string().max(28).transform(value => value.trim().replace(/[\s().-]/g, ""))
  .pipe(z.string().regex(/^(?:\+?1)?[2-9]\d{2}[2-9]\d{6}$/))
  .transform(value => `+1${value.slice(-10)}`);
export const usPostalCode = z.string().trim().regex(/^\d{5}(?:-\d{4})?$/);
export const contiguousStates = new Set(
  "AL AZ AR CA CO CT DE DC FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NH NJ NM NV NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "),
);
const usStates = new Set([...contiguousStates, "AK", "HI"]);

const addressBase = {
  name: addressText(2, 100),
  email: optionalEmail,
  locality: addressText(2, 100),
  address: addressText(5, 240),
};

const districts = z.object({
  // The original district contract allowed country omission and existing attempts retain that shape.
  country: z.literal("BD").optional(),
  name: addressBase.name,
  phone: bdPhone,
  email: addressBase.email,
  district: z.string().trim().regex(/^[a-z][a-z-]{1,39}$/),
  locality: addressBase.locality,
  address: addressBase.address,
  postalCode: z.union([z.string().trim().regex(/^\d{4}$/), z.literal(""), z.null()]).optional().transform(value => value || null),
});

const usPostal = z.object({
  ...addressBase,
  country: z.literal("US"),
  phone: usPhone,
  district: z.string().trim().toUpperCase().refine(value => usStates.has(value)).transform(value => value.toLowerCase()),
  postalCode: usPostalCode,
});

const adapters = { "bd-district": districts, "us-postal": usPostal };
export type AddressAdapter = keyof typeof adapters;
export const checkoutAddressInput = z.union([districts, usPostal]);

export function addressMatchesAdapter(adapter: AddressAdapter, countryCode: string, customer: z.output<typeof checkoutAddressInput>) {
  return countryCode === (customer.country ?? "BD") && adapters[adapter].safeParse({
    ...customer, email: customer.email ?? "",
  }).success;
}

export function fixtureAddress(adapter: AddressAdapter, customer: z.output<typeof checkoutAddressInput>) {
  const contact = { name: "GriipBuddy Demo Buyer", email: "checkout@example.invalid", locality: "Demo area", address: "Demo street address" };
  return adapter === "us-postal" && customer.country === "US"
    ? { ...customer, ...contact, phone: "+12025550100" }
    : { ...customer, ...contact, phone: "+8801700000000", postalCode: null };
}
