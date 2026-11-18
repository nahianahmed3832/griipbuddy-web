import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { bdOrderHubConfig, OrderHubBridgeError } from "@/lib/marketplace/bd-order-hub-bridge";
import { bdOrderCommand, confirmBangladeshRecovery, recoverWithVerifiedPhone, saveLegacyAccount, startBangladeshRecovery } from "@/lib/marketplace/bd-order-hub";
import { getShopper } from "@/lib/marketplace/auth";
import { accountText } from "@/lib/marketplace/account-language";
import { currentAccountLanguage } from "@/lib/marketplace/account-language-server";
import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { clientKey, consumeQuota, reportFailure } from "@/lib/db/observability";
import { demoSellerOrigin } from "@/lib/release-config";

function json(data: object, status = 200) {
  return Response.json(data, { status, headers: privateHeaders });
}

export async function POST(request: Request) {
  if (!bdOrderHubConfig()) return json({}, 404);
  if (!sameOrigin(request) || request.headers.get("origin") === demoSellerOrigin) return json({}, 403);
  const shopper = await getShopper();
  if (!shopper) return json({ message: "Sign in to recover an order." }, 401);
  const language = await currentAccountLanguage("bd");
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const parsed = bdOrderCommand.safeParse(await readJson(request, 4096));
  if (!parsed.success) return json({ message: t("Check the information and try again.", "তথ্য যাচাই করে আবার চেষ্টা করুন।") }, 400);
  const command = parsed.data;
  const unavailable = t("We couldn’t verify this request. Check your information and try again.",
    "এই অনুরোধ যাচাই করা যায়নি। তথ্য যাচাই করে আবার চেষ্টা করুন।");
  try {
    const scope = `bd-orders.${command.action}`;
    const max = command.action === "start" || command.action === "link" ? 6 : 20;
    const ip = clientKey(request.headers);
    if (!await consumeQuota(scope, shopper.id, max, 600) ||
        ip !== "unattributed" && !await consumeQuota(`${scope}.ip`, ip, 60, 600) ||
        command.action === "start" && !await consumeQuota(`${scope}.recipient`, command.email, 8, 600) ||
        command.action === "link" && !await consumeQuota(`${scope}.phone`, command.phone.replace(/\D/g, "").slice(-10), 12, 600)) {
      return json({ message: t("Too many attempts. Try again in a few minutes.", "অনেকবার চেষ্টা করেছেন। কয়েক মিনিট পর আবার চেষ্টা করুন।") }, 429);
    }
    if (command.action === "start") {
      const challenge = randomUUID();
      after(async () => {
        try {
          await startBangladeshRecovery(challenge, shopper.id, command, language);
        } catch (error) {
          reportFailure("bd-order-hub.dispatch", undefined, error);
        }
      });
      return json({ data: { challenge } });
    }
    const verified = command.action === "link" ? await saveLegacyAccount(shopper.id, command.phone, command.password)
      : command.action === "verified-phone" ? await recoverWithVerifiedPhone(shopper.id, command)
      : await confirmBangladeshRecovery(shopper.id, command);
    return verified ? json({ data: {} }) : json({ message: unavailable }, 422);
  } catch (error) {
    if (error instanceof OrderHubBridgeError && [400, 401, 403, 404, 409, 422].includes(error.status)) {
      return json({ message: unavailable }, 422);
    }
    reportFailure("bd-order-hub.verify", undefined, error);
    return json({ message: t("Order recovery is temporarily unavailable. Try again shortly.",
      "অর্ডার পুনরুদ্ধার সাময়িকভাবে বন্ধ আছে। কিছুক্ষণ পর আবার চেষ্টা করুন।") }, 503);
  }
}
