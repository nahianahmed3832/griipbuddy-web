import { manualPaymentMethods, type ManualPaymentInstructions, type ManualPaymentMethod } from "./manual-payment-methods.ts";
import { productionMode } from "../release-config.ts";

export function manualPaymentInstructions(method: ManualPaymentMethod): ManualPaymentInstructions | undefined {
  if (!productionMode()) {
    if (process.env.BD_MANUAL_TEST_MODE !== "1") return undefined;
    return { method, recipient: method === "ROCKET" ? "01XXXXXXXXXX" : "01XXXXXXXXX", test: true };
  }
  const recipient = process.env[`BD_MANUAL_${method}_NUMBER`]?.trim();
  const format = method === "ROCKET" ? /^(?:\+?880|0)1[3-9]\d{8,9}$/ : /^(?:\+?880|0)1[3-9]\d{8}$/;
  if (!recipient || !format.test(recipient)) return undefined;
  return { method, recipient, test: false };
}

export function configuredManualPayments(): ManualPaymentInstructions[] {
  return manualPaymentMethods.flatMap(method => manualPaymentInstructions(method) ?? []);
}
