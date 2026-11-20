export function priceInMinor(raw: string, digits: number) {
  const value = raw.trim().replace(/[০-৯]/gu, character => String(character.codePointAt(0)! - 0x09E6));
  if (!/^\d{1,10}(?:\.\d{1,3})?$/.test(value)) return undefined;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > digits) return undefined;
  const amount = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0"));
  return amount <= 2_147_483_647 ? String(amount) : undefined;
}
