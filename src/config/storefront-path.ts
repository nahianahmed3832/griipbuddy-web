export const storefrontBasePath = process.env.NEXT_PUBLIC_STOREFRONT_BASE_PATH ?? "";
export const storefrontCookiePath = storefrontBasePath || "/";

export function storefrontPath(path: string): string {
  return storefrontBasePath + path;
}
