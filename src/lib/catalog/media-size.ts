export const catalogMediaPath = /^\/media\/[a-f0-9]{64}$/;

export const catalogMediaSizes = {
  thumbnail: [160],
  card: [320, 480, 640],
  detail: [480, 768, 960, 1280],
} as const;

const permittedWidths = new Set(Object.values(catalogMediaSizes).flat().map(String));

export function catalogMediaWidth(values: readonly string[]) {
  if (!values.length) return undefined;
  if (values.length !== 1 || !permittedWidths.has(values[0])) return null;
  return Number(values[0]);
}
