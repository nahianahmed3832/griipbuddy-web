export const storeShop = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "griipbuddy",
  name: "GriipBuddy",
} as const;

export type ShopSummary = { id: string; slug: string; name: string };
export type ListSummary = { id: string; name: string; registry: boolean; public: boolean };
