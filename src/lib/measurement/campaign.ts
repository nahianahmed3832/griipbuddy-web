// Only reviewed, public campaign labels may be stored. Other values become unknown.
export const acquisitionCampaign = {
  label: "bd-phone3a-camera-01",
  marketId: "bd",
  productId: "p-69ce0eda0941968059400765",
  variantId: "v-69ce0eda0941968059400767",
  slug: "nothing-phone-3a-premium-camera-protector-a61999",
  utm: {
    utm_source: "facebook",
    utm_medium: "paid_social",
    utm_campaign: "bd-phone3a-camera-01",
    utm_content: "catalog-photo-01",
  },
} as const;

export const acquisitionDestination = `https://frontend.griipbuddy.com/products/${acquisitionCampaign.slug}?${new URLSearchParams({
  variant: acquisitionCampaign.variantId,
  ...acquisitionCampaign.utm,
})}`;

export function campaignLabel(input: Record<string, unknown> | undefined) {
  return input && Object.entries(acquisitionCampaign.utm).every(([key, value]) => input[key] === value)
    ? acquisitionCampaign.label : null;
}

export function publicCampaignFields(query: string) {
  const parameters = new URLSearchParams(query);
  if (!Object.entries(acquisitionCampaign.utm).every(([key, value]) => {
    const matches = parameters.getAll(key);
    return matches.length === 1 && matches[0] === value;
  })) return undefined;
  return acquisitionCampaign.utm;
}
