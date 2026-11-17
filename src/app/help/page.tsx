import Link from "next/link";
import { notFound } from "next/navigation";
import { marketStoreHref } from "@/config/regional-path";
import { currentMarket } from "@/lib/market-server";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";

export const metadata = { title: "Help Center" };
const topics = [
  ["Purchases and reviews", "Find the status of your order, leave a review or ask for help.", "/orders"],
  ["Messages", "See your conversations with GriipBuddy support.", "/messages"],
  ["Delivery and payment", "Find delivery and payment options by destination.", "/help/delivery"],
  ["Returns and refunds", "Find out where to get help with a return.", "/help/returns"],
  ["Your account", "Update your display name, password and saved addresses.", "/account"],
  ["Privacy", "Read what GriipBuddy stores about you.", "/help/privacy"],
  ["Terms", "Read the terms for this development store.", "/help/terms"],
] as const;

export default async function HelpPage() {
  if (!marketplaceMode()) notFound();
  const region = hybridDemoMode() ? (await currentMarket()).id : undefined;
  return <div className="shell mp-page">
    <header className="mp-shop-hero"><h1 className="mp-page-title">GriipBuddy Help Center</h1>
      <p>Find answers or get in touch about your purchase.</p></header>
    <ul className="mp-shop-grid">{topics.map(([title, detail, href]) => <li key={href}><Link href={marketStoreHref(href, region)}><strong>{title}</strong><p>{detail}</p></Link></li>)}</ul>
    <p className="mp-section">For anything else, contact <a href="mailto:contact@griipbuddy.com">contact@griipbuddy.com</a>.</p>
  </div>;
}
