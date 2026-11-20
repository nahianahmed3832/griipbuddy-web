const swatches: Record<string, string> = {
  black: "#252426", blue: "#546c9a", brown: "#795a49", charcoal: "#47474b", cream: "#eee1c7",
  green: "#567756", grey: "#797d84", gray: "#797d84", lilac: "#ae94b8", navy: "#283953",
  orange: "#ae582c", pink: "#d597a9", purple: "#745080", red: "#9c323d", silver: "#a4a7af",
  white: "#fff", yellow: "#ecc75d",
};

export function optionColorSwatch(value: string) {
  const key = value.trim().toLowerCase();
  return Object.hasOwn(swatches, key) ? swatches[key] : undefined;
}
