import Link from "next/link";
import { notFound } from "next/navigation";
import { Camera, MessagesSquare, Store } from "lucide-react";
import { marketplaceMode } from "@/lib/release-config";

export const metadata = { title: "Sell on GriipBuddy" };

export default function SellPage() {
  if (!marketplaceMode()) notFound();
  return <div className="shell mp-page">
    <header className="mp-shop-hero mp-sell-hero">
      <h1 className="mp-page-title">Sell on GriipBuddy</h1>
      <p>Open a shop, create listings and help shoppers get to know what you sell.</p>
      <Link className="button button--primary" href="/seller">Open your shop</Link>
    </header>
    <div className="mp-shop-grid mp-section">
      <section className="mp-list-card"><Store aria-hidden="true"/><h2>Introduce your shop</h2><p>Choose a name and tell shoppers what makes your shop yours.</p></section>
      <section className="mp-list-card"><Camera aria-hidden="true"/><h2>Build your listings</h2><p>Add product details, photos, prices and stock. An owner reviews the shop and listings before they appear.</p></section>
      <section className="mp-list-card"><MessagesSquare aria-hidden="true"/><h2>Talk to shoppers</h2><p>Follow test orders and answer questions in your shop inbox.</p></section>
    </div>
    <p>This is a marketplace preview for Bangladesh. Orders and inventory here are for testing.</p>
  </div>;
}
