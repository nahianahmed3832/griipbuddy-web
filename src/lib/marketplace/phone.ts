import { createHmac, timingSafeEqual } from "node:crypto";
import { phoneNumber } from "better-auth/plugins/phone-number";
import { hybridDemoMode } from "../release-config.ts";

export const demoEmail = "test@griipbuddy.com";
export const demoPhone = "+12025550143";
export const validPhoneNumber = /^\+[1-9]\d{7,14}$/;

function twilioConfig() {
  const { SHOPPER_VERIFY_SERVICE: service, SHOPPER_VERIFY_ACCOUNT: account, SHOPPER_VERIFY_TOKEN: token } = process.env;
  return service && /^VA[a-f0-9]{32}$/i.test(service) && account && /^AC[a-f0-9]{32}$/i.test(account) && token
    ? { service, account, token } : null;
}

export function demoPhoneConfigured() {
  return hybridDemoMode() && /^\d{6}$/.test(process.env.SHOPPER_DEMO_PHONE_CODE ?? "");
}

export function phoneCanAuthenticate(phone: string) {
  return validPhoneNumber.test(phone) && (Boolean(twilioConfig()) || phone === demoPhone && demoPhoneConfigured());
}

async function verification(action: "Verifications" | "VerificationCheck", fields: Record<string, string>) {
  const config = twilioConfig();
  if (!config) return false;
  const response = await fetch(`https://verify.twilio.com/v2/Services/${config.service}/${action}`, {
    method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: "Basic " + Buffer.from(`${config.account}:${config.token}`).toString("base64") },
    body: new URLSearchParams(fields),
  });
  if (!response.ok) return false;
  const payload: { status?: unknown } = await response.json();
  return payload.status === (action === "Verifications" ? "pending" : "approved");
}

export function shopperPhonePlugin(secret: string) {
  return phoneNumber({
    otpLength: 6, expiresIn: 300, allowedAttempts: 4,
    phoneNumberValidator: phoneCanAuthenticate,
    async sendOTP({ phoneNumber: phone }) {
      if (phone === demoPhone && demoPhoneConfigured()) return;
      if (!await verification("Verifications", { To: phone, Channel: "sms" })) throw new Error("Phone verification unavailable");
    },
    async verifyOTP({ phoneNumber: phone, code }) {
      if (phone === demoPhone && demoPhoneConfigured()) {
        return /^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(code), Buffer.from(process.env.SHOPPER_DEMO_PHONE_CODE!));
      }
      return verification("VerificationCheck", { To: phone, Code: code });
    },
    signUpOnVerification: {
      getTempEmail: phone => `${createHmac("sha256", secret).update(phone).digest("hex")}@phone.griipbuddy.invalid`,
      getTempName: () => "Phone shopper",
    },
  });
}
