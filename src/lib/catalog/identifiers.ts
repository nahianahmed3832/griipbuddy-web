const gtinDigits = /^(?:[0-9]{8}|[0-9]{12,14})$/;

export function validGtin(value: unknown): value is string {
  if (typeof value !== "string" || !gtinDigits.test(value) || /^0+$/.test(value)) return false;

  // UPC-A carries an implicit zero before its GS1 prefix. In GTIN-14 the
  // leading digit indicates the packaging level and is not part of the prefix.
  if (value.length === 8) {
    if (/^[02]/.test(value)) return false; // Restricted-circulation numbers
  } else {
    const prefixed = value.length === 14 ? value.slice(1) : value.padStart(13, "0");
    if (/^(?:02|04|05|2|98|99)/.test(prefixed)) return false;
  }

  let sum = 0;
  for (let index = value.length - 2, weight = 3; index >= 0; index--, weight = 4 - weight) {
    sum += Number(value[index]) * weight;
  }
  return (10 - sum % 10) % 10 === Number(value.at(-1));
}
