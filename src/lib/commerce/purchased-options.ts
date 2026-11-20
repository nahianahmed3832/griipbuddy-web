export function purchasedOptions(line: { variantName: string; optionsSnapshot?: unknown }) {
  const options = line.optionsSnapshot;
  if (!Array.isArray(options)) return line.variantName;
  const labels = options.flatMap((value: unknown) => {
    if (!value || typeof value !== "object" || !("name" in value) || !("value" in value) ||
      typeof value.name !== "string" || typeof value.value !== "string") return [];
    return value.value ? [value.name ? `${value.name} ${value.value}` : value.value] : [];
  });
  return labels.join(" · ") || line.variantName;
}
