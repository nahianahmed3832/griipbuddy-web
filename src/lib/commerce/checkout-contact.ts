export type CheckoutContact = { name: string; email: string; phone: string };

export type CheckoutContactBinding = {
  value: CheckoutContact;
  onChange: (value: CheckoutContact, source?: "saved-address" | "new-address") => void;
};

export function checkoutContact({ name = "", email = "", phone = "" }: Partial<CheckoutContact> = {}): CheckoutContact {
  return { name, email, phone };
}
