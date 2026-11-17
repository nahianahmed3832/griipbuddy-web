import type { PaymentStatus } from "../../generated/prisma/enums.ts";
import { marketStoreHref } from "../../config/regional-path.ts";
import { storefrontPath } from "../../config/storefront-path.ts";
import { accountLanguage, accountText, type AccountLanguage } from "../marketplace/account-language.ts";
import { getDb } from "../db/client.ts";
import { reportFailure } from "../db/observability.ts";
import { hybridDemoMode } from "../release-config.ts";
import { createGuestOrderLink } from "./order-recovery.ts";
import { sendShopperMail, shopperMailAvailable } from "./shopper-mail.ts";

const shipmentMessages = {
  shipped: { subject: "Your order shipped", detail: "Your test order was marked shipped." },
  "out-for-delivery": { subject: "Your order is out for delivery", detail: "The courier marked your test order out for delivery." },
  delivered: { subject: "Your order was delivered", detail: "The courier marked your test order delivered." },
  refused: { subject: "Delivery status updated", detail: "The courier reported that delivery of your test order was refused." },
} satisfies Record<string, { subject: string; detail: string }>;

const banglaShipping = {
  shipped: { subject: "আপনার অর্ডার পাঠানো হয়েছে", detail: "আপনার পরীক্ষামূলক অর্ডার পাঠানো হয়েছে।" },
  "out-for-delivery": { subject: "অর্ডারটি ডেলিভারির পথে", detail: "কুরিয়ার অর্ডারটি ডেলিভারির পথে বলে জানিয়েছে।" },
  delivered: { subject: "আপনার অর্ডার পৌঁছেছে", detail: "কুরিয়ার অর্ডার পৌঁছে দিয়েছে।" },
  refused: { subject: "ডেলিভারির অবস্থা বদলেছে", detail: "কুরিয়ার জানিয়েছে, ডেলিভারিটি গ্রহণ করা হয়নি।" },
} as const;

export type OrderNotice = "received" | keyof typeof shipmentMessages;

export function orderNoticeContent(notice: OrderNotice, reference: string, link: string, privateLink: boolean, payment?: PaymentStatus, language: AccountLanguage = "en") {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const description = notice === "received" ? {
    subject: t("We received your order", "আপনার অর্ডার গ্রহণ করা হয়েছে"),
    detail: payment === "AWAITING_VERIFICATION"
      ? t("We received your test order. Your payment proof is awaiting verification.", "পরীক্ষামূলক অর্ডার গ্রহণ করা হয়েছে। পেমেন্টের প্রমাণ যাচাইয়ের অপেক্ষায় আছে।")
      : t("We received your GriipBuddy test order.", "আপনার GriipBuddy পরীক্ষামূলক অর্ডার গ্রহণ করা হয়েছে।"),
  } : (language === "bn" ? banglaShipping : shipmentMessages)[notice];
  return {
    kind: notice === "received" ? "order-confirmation" as const : "shipment-update" as const,
    subject: `${t("[Test order]", "[পরীক্ষামূলক অর্ডার]")} ${description.subject} · ${reference}`,
    text: [
      description.detail,
      `${t("Order reference", "অর্ডার নম্বর")}: ${reference}`,
      privateLink
        ? `${t("Track your order", "অর্ডার ট্র্যাক করুন")}: ${link}\n${t("This private link works for seven days. Keep it private.", "ব্যক্তিগত লিংকটি সাত দিন কাজ করবে। এটি গোপন রাখুন।")}`
        : `${t("Sign in to view your order", "অর্ডার দেখতে সাইন ইন করুন")}: ${link}`,
      t("This message is for the GriipBuddy development storefront.", "এই বার্তাটি GriipBuddy পরীক্ষামূলক সাইটের জন্য।"),
    ].join("\n\n"),
  };
}

// Call only after the native order or shipment transaction commits. Mail failure cannot change its result.
export async function notifyOrder(orderId: string, notice: OrderNotice) {
  try {
    if (!hybridDemoMode() || !shopperMailAvailable()) return;
    const base = process.env.BETTER_AUTH_URL;
    if (!base || !URL.canParse(base)) return;
    const origin = new URL(base);
    const loopback = ["http:", "https:"].includes(origin.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if (process.env.COMMERCE_MODE === "local" && !loopback) return;
    const order = await getDb().order.findFirst({
      where: { id: orderId, measurementTest: true, status: "PLACED" },
      select: { id: true, reference: true, marketId: true, email: true, shopperId: true,
        attempt: { select: { guestKey: true } }, payment: { select: { status: true } } },
    });
    if (!order?.email) return;
    const link = order.shopperId ? null : await createGuestOrderLink(order.id, order.attempt.guestKey);
    const accountPath = storefrontPath(marketStoreHref("/orders", order.marketId));
    const url = new URL(link?.path ?? accountPath, origin.origin).href;
    const preference = order.shopperId && order.marketId === "bd" ? await getDb().shopperMarketProfile.findUnique({
      where: { shopperId_marketId: { shopperId: order.shopperId, marketId: order.marketId } }, select: { language: true },
    }) : null;
    await sendShopperMail({
      ...orderNoticeContent(notice, order.reference, url, Boolean(link), order.payment?.status, accountLanguage(order.marketId, preference?.language)),
      to: order.email,
      key: `order-${order.id}-${notice}`,
    });
  } catch (error) {
    reportFailure(`shopper-mail.order-${notice}`, undefined, error);
  }
}
