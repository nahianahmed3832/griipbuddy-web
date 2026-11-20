export const searchQueryMaxLength = 120;

export function readSearchQuery(value: string | readonly string[] | undefined): string | null {
  if (value === undefined) return "";
  if (typeof value !== "string") return null;
  const query = value.trim();
  return query.length <= searchQueryMaxLength && !/\p{Cc}/u.test(query) ? query : null;
}
