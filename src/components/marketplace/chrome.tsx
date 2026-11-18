import Link from "next/link";
import { ArrowUpRight, Headphones, Heart, PackageCheck, Truck, Undo2 } from "lucide-react";
import { Suspense } from "react";
import { marketStoreHref } from "@/config/regional-path";
import type { Market } from "@/config/markets";
import { store } from "@/config/store";
import type { Department } from "@/lib/catalog/types";
import { departmentTree } from "@/lib/catalog/departments";
import { bdOrderHubConfig } from "@/lib/marketplace/bd-order-hub-bridge";
import { hybridDemoMode, hybridStoreMode } from "@/lib/release-config";
import { activeOffer, ordered, readAdminContent } from "@/lib/marketplace/admin-content";
import { CartLink } from "../cart-link";
import { MarketPicker } from "../market-picker";
import { Wordmark } from "../wordmark";
import { MarketplaceHeaderSearch, MarketplaceSearch } from "./search";
import { ShopperMenu } from "./session";
import { MobileStoreNav, StoreCategoryMenu, StoreShopNavigation } from "./store-navigation";
import "./store-navigation.css";
import "./merchandising.css";
import "./profile-menu.css";

export async function MarketplaceHeader({ departments, market }: { departments: readonly Department[]; market: Market }) {
  const roots = departmentTree(departments);
  const region = hybridDemoMode() ? market.id : undefined;
  const localHref = (href: string) => marketStoreHref(href, region);
  const hybrid = hybridStoreMode();
  const adminContent = market.id === "bd" ? await readAdminContent() : null;
  const messages = ordered(adminContent?.content?.top_bar_messages);
  const dealLabel = activeOffer(adminContent?.offer)?.navbar_label ?? "Deals";
  const search = { firstParty: !hybrid, marketId: hybrid ? market.id : undefined };
  return (
    <header className="site-header mp-header mp-store-header" data-market={market.id}>
      {messages.length > 0 && <div className="preview-strip">{messages.map((row, index) =>
        <span key={row.message + index}>{index > 0 ? " · " : ""}{row.message}</span>)}</div>}
      <div className="shell site-header__row mp-header-row">
        <Wordmark href={localHref("/")} />
        <StoreCategoryMenu departments={roots} region={region} />
        <div className="site-header__search">
          <Suspense fallback={<MarketplaceSearch {...search} />}><MarketplaceHeaderSearch {...search} /></Suspense>
        </div>
        <div className="mp-header-actions">
          <ShopperMenu orderUpdates={market.id === "bd" && Boolean(bdOrderHubConfig())} />
          <Link className="mp-icon mp-header-saved" href={localHref("/favorites")} aria-label="Saved items" title="Saved items">
            <Heart size={22} aria-hidden="true" />
          </Link>
          <CartLink />
        </div>
      </div>
      <StoreShopNavigation departments={roots} showShops={hybrid} dealLabel={dealLabel} region={region} />
    </header>
  );
}

const shoppingHelp = [
  { label: "Delivery & payment", icon: Truck, href: "/help/delivery" },
  { label: "Track an order", icon: PackageCheck, href: "/orders" },
  { label: "Returns & refunds", icon: Undo2, href: "/help/returns" },
  { label: "Customer support", icon: Headphones, href: "/help" },
] as const;

export function MarketplaceFooter({ market, regionalRouting = false }: { market: Market; regionalRouting?: boolean }) {
  const region = regionalRouting ? market.id : undefined;
  const localHref = (href: string) => marketStoreHref(href, region);
  return (
    <footer className="mp-store-footer">
      <nav className="mp-store-footer-guide" aria-label="Shopping help">
        <ul className="shell">
          {shoppingHelp.map(({ href, label, icon: Icon }) => (
            <li key={href}>
              <Link href={localHref(href)}>
                <Icon size={22} strokeWidth={1.7} aria-hidden="true" />
                <span>{label}</span>
                <ArrowUpRight size={15} strokeWidth={1.7} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="shell mp-store-footer-content">
        <div className="mp-store-footer-brand">
          <Wordmark href={localHref("/")} />
          <a href={`mailto:${store.supportEmail}`}>{store.supportEmail}</a>
        </div>
        <nav className="mp-store-footer-links" aria-label="Shop">
          <h2>Shop</h2>
          <Link href={localHref("/shop")}>Shop all</Link>
          <Link href={localHref("/shop?sort=newest")}>New arrivals</Link>
          <Link href={localHref("/shop?offer=sale")}>Deals</Link>
          <Link href={localHref("/favorites")}>Saved items</Link>
        </nav>
        <nav className="mp-store-footer-links" aria-label="Orders and help">
          <h2>Orders &amp; Help</h2>
          <Link href={localHref("/orders")}>Order status</Link>
          <Link href={localHref("/help/delivery")}>Delivery &amp; payment</Link>
          <Link href={localHref("/help/returns")}>Returns &amp; refunds</Link>
          <Link href={localHref("/help")}>Help Center</Link>
        </nav>
        <nav className="mp-store-footer-links" aria-label="About">
          <h2>About</h2>
          <Link href={localHref("/help/terms")}>Terms of use</Link>
          <Link href={localHref("/help/privacy")}>Privacy</Link>
          {hybridStoreMode() && <Link href="/seller">Seller portal</Link>}
        </nav>
      </div>
      <div className="mp-store-footer-base">
        <div className="shell mp-store-footer-meta">
          <MarketPicker market={market} marketplace regionalRouting={regionalRouting} />
          <small>© {new Date().getFullYear()} GriipBuddy</small>
        </div>
      </div>
      <MobileStoreNav region={region} />
    </footer>
  );
}
