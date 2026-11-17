export const manualPaymentMethods = ["BKASH", "NAGAD", "ROCKET"] as const;
export type ManualPaymentMethod = typeof manualPaymentMethods[number];

export const manualPaymentLabels: Record<ManualPaymentMethod, string> = {
  BKASH: "bKash", NAGAD: "Nagad", ROCKET: "Rocket",
};

export function isManualPaymentMethod(value: string): value is ManualPaymentMethod {
  return manualPaymentMethods.some(method => method === value);
}

export type ManualPaymentInstructions = {
  method: ManualPaymentMethod;
  recipient: string;
  test: boolean;
};

export const manualReceiptLimit = 4 * 1024 * 1024;
