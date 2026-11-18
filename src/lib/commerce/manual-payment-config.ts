import { manualPaymentMethods, type ManualPaymentInstructions, type ManualPaymentMethod } from "./manual-payment-methods.ts";
import { hybridDemoMode, productionMode } from "../release-config.ts";

const mobileNumber = /^(?:\+?880|0)1[3-9]\d{8}$/;

export function manualPaymentInstructions(method: ManualPaymentMethod): ManualPaymentInstructions | undefined {
  if (!productionMode()) {
    if (process.env.BD_MANUAL_TEST_MODE !== "1") return undefined;
    const configured = hybridDemoMode() ? process.env.BD_MANUAL_TEST_RECIPIENT?.trim() : undefined;
    const example = method === "ROCKET" ? "01XXXXXXXXXX" : "01XXXXXXXXX";
    return { method, recipient: configured && mobileNumber.test(configured) ? configured : example, test: true };
  }
  const recipient = process.env[`BD_MANUAL_${method}_NUMBER`]?.trim();
  const format = method === "ROCKET" ? /^(?:\+?880|0)1[3-9]\d{8,9}$/ : mobileNumber;
  if (!recipient || !format.test(recipient)) return undefined;
  return { method, recipient, test: false };
}

export function configuredManualPayments(): ManualPaymentInstructions[] {
  return manualPaymentMethods.flatMap(method => manualPaymentInstructions(method) ?? []);
}
