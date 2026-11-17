import { createHash } from "node:crypto";
import { createTransport } from "nodemailer";
import { z } from "zod";
import { accountText, type AccountLanguage } from "../marketplace/account-language.ts";
import { getDb } from "../db/client.ts";
import { hybridDemoMode, marketplaceMode } from "../release-config.ts";

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const previewAddress = /^[^@]+@example\.invalid$/;
const messageInput = z.object({
  kind: z.enum(["verify-email", "password-reset", "order-confirmation", "shipment-update"]),
  to: email,
  subject: z.string().trim().min(1).max(160).regex(/^[^\r\n]+$/),
  text: z.string().min(1).max(12_000),
  key: z.string().min(1).max(180).optional(),
});

export type ShopperMailMessage = z.input<typeof messageInput>;
export const shopperMailPreviewDays = 7;

export function shopperMailPreview() {
  return process.env.SHOPPER_MAIL_MODE === "preview" && hybridDemoMode();
}

function smtpConfig() {
  if (process.env.SHOPPER_MAIL_MODE !== "smtp" || !marketplaceMode() || hybridDemoMode()) return;
  const from = email.safeParse(process.env.SHOPPER_MAIL_FROM);
  if (!from.success || !process.env.SHOPPER_SMTP_URL) return;
  try {
    const url = new URL(process.env.SHOPPER_SMTP_URL);
    if (!["smtps:", "smtp:"].includes(url.protocol) || !url.hostname || !url.username || !url.password ||
        url.search || url.hash || !["", "/"].includes(url.pathname)) return;
    const secure = url.protocol === "smtps:";
    const port = url.port ? Number(url.port) : secure ? 465 : 587;
    if (port < 1 || port > 65535) return;
    const auth = { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) };
    return { from: from.data, host: url.hostname, port, secure, auth };
  } catch {
    return;
  }
}

export function shopperMailAvailable() {
  return shopperMailPreview() || Boolean(smtpConfig());
}

export function shopperMailSupports(address: string) {
  const to = email.safeParse(address);
  if (!to.success) return false;
  return shopperMailPreview() ? previewAddress.test(to.data) : Boolean(smtpConfig()) && !to.data.endsWith(".invalid");
}

export function shopperMailPreviewCutoff(now = Date.now()) {
  return new Date(now - shopperMailPreviewDays * 86_400_000);
}

export async function sendShopperMail(raw: ShopperMailMessage): Promise<"preview" | "sent" | "disabled"> {
  const message = messageInput.parse(raw);
  if (!shopperMailSupports(message.to)) return "disabled";
  if (shopperMailPreview()) {
    const db = getDb();
    await db.shopperMailRecord.deleteMany({ where: { status: "CAPTURED", createdAt: { lt: shopperMailPreviewCutoff() } } });
    await db.shopperMailRecord.createMany({ skipDuplicates: true, data: {
      deliveryKey: message.key, kind: message.kind, status: "CAPTURED",
      recipient: message.to, subject: message.subject, text: message.text,
    } });
    return "preview";
  }

  const smtp = smtpConfig();
  if (!smtp) return "disabled";
  const delivery = message.key ? getDb().shopperMailRecord : null;
  if (delivery) {
    const claim = await delivery.createMany({ skipDuplicates: true, data: {
      deliveryKey: message.key, kind: message.kind, status: "SENDING",
    } });
    if (!claim.count) return "disabled";
  }

  const mailer = createTransport({
    host: smtp.host, port: smtp.port, secure: smtp.secure, requireTLS: true, auth: smtp.auth,
    connectionTimeout: 5_000, greetingTimeout: 5_000, socketTimeout: 8_000,
  });
  try {
    const result = await mailer.sendMail({
      from: { name: "GriipBuddy", address: smtp.from }, to: message.to,
      subject: message.subject, text: message.text, disableFileAccess: true, disableUrlAccess: true,
      ...(message.key && { messageId: `<${createHash("sha256").update(message.key).digest("hex")}@${smtp.from.split("@")[1]}>` }),
    });
    if (result.accepted.length !== 1) throw new Error();
    if (message.key && delivery) await delivery.update({ where: { deliveryKey: message.key }, data: { status: "SENT" } });
  } catch {
    // SMTP can accept a message even if the connection closes before the final acknowledgement.
    // Keep the event key so repeating the order action does not send the same message twice.
    if (message.key && delivery) await delivery.updateMany({ where: { deliveryKey: message.key, status: "SENDING" }, data: { status: "FAILED" } }).catch(() => {});
    throw new Error("Shopper email delivery failed.");
  }
  return "sent";
}

export async function sendShopperAccountMail({ kind, email: address, url, language = "en" }: { kind: "verify" | "reset"; email: string; url: string; language?: AccountLanguage }) {
  if (!shopperMailSupports(address)) return;
  const link = new URL(url);
  if (link.origin !== new URL(process.env.BETTER_AUTH_URL ?? "").origin) throw new Error("Invalid shopper email link.");
  const title = kind === "verify" ? accountText(language, "Verify your GriipBuddy email", "GriipBuddy ইমেইল যাচাই করুন")
    : accountText(language, "Reset your GriipBuddy password", "GriipBuddy পাসওয়ার্ড পুনরায় সেট করুন");
  await sendShopperMail({
    kind: kind === "verify" ? "verify-email" : "password-reset", to: address,
    subject: title,
    text: `${title}\n\n${link.href}\n\n${accountText(language, "If you didn’t request this, you can ignore this email.", "আপনি অনুরোধ না করে থাকলে এই ইমেইলটি উপেক্ষা করুন।")}`,
  });
}
