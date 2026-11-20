import type { MarketId } from "../../config/markets.ts";
import { isMarketSelectable } from "../market-config.ts";
import { notificationSandbox } from "./test-delivery.ts";

export function whatsAppContact(marketId: MarketId) {
  const entry = process.env[`GRIIP_WHATSAPP_TEST_CONTACT_${marketId.toUpperCase()}`];
  return notificationSandbox() && isMarketSelectable(marketId) && entry && /^\+[1-9][0-9]{7,14}$/.test(entry)
    ? entry.slice(1) : undefined;
}

function browserDraft(marketId: MarketId, message: string) {
  const number = whatsAppContact(marketId);
  if (!number) return undefined;
  const link = new URL(`https://wa.me/${number}`);
  link.searchParams.set("text", message);
  return link.href;
}

export function whatsAppProductInquiry(marketId: MarketId, name: string, productUrl: string) {
  try {
    const url = new URL(productUrl);
    const site = new URL(process.env.BETTER_AUTH_URL ?? "");
    if (url.origin !== site.origin || url.username || url.password || !/\/products\/[a-z0-9-]+$/i.test(url.pathname)) return undefined;
    url.search = "";
    url.hash = "";
    url.searchParams.set("market", marketId);
    const title = name.replace(/[\p{Cc}]/gu, " ").trim().slice(0, 120);
    return title ? browserDraft(marketId, `Hello, I have a question about ${title}. ${url.href}`) : undefined;
  } catch {
    return undefined;
  }
}

export function whatsAppOrderInquiry(marketId: MarketId, reference: string) {
  if (!/^[a-z0-9-]{3,42}$/i.test(reference)) return undefined;
  return browserDraft(marketId, `Hello, I have a question about order ${reference}.`);
}
