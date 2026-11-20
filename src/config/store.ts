export const store = {
  name: "GriipBuddy",
  language: "en",
  supportEmail: "contact@griipbuddy.com",
  policies: [
    { label: "Order status", href: "/orders" },
    { label: "Delivery", href: "/help/delivery" },
    { label: "Cancellations, returns and refunds", href: "/help/returns" },
    { label: "Privacy", href: "/help/privacy" },
    { label: "Terms", href: "/help/terms" },
  ],
  previewNotice: "Staging preview · Sample products and test orders",
  description: "Thoughtfully chosen finds for the way you live.",
} as const;

export const demoAccount = {
  email: "shopper@example.com",
  cookie: "griipbuddy-demo-account",
} as const;
