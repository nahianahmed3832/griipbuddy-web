"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, type ReactNode } from "react";
import { ArrowUpRight, Bell, Boxes, ChartNoAxesCombined, ChevronDown, ChevronRight, Globe2, LayoutDashboard, Menu,
  MessageSquareText, Package, RotateCcw, Settings2, ShoppingBag, Star, Store, TicketPercent, Users, X } from "lucide-react";
import type { MarketId } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { useConfirmTaxonomyNavigation } from "@/components/taxonomy-controls";
import { ShopperMenu } from "./session";
import type { SellerPermission } from "@/lib/marketplace/seller-access";

const groups = [
  { label: "Daily work", links: [
    { label: "Overview", href: "/seller", icon: LayoutDashboard },
    { label: "Products", href: "/seller/listings", icon: Boxes },
    { label: "Reviews", href: "/seller/reviews", icon: Star },
    { label: "Inventory", href: "/seller/inventory", icon: Package },
    { label: "Orders", href: "/seller/orders", icon: ShoppingBag },
    { label: "Notifications", href: "/seller/notifications", icon: Bell },
    { label: "After-sales", href: "/seller/cases", icon: RotateCcw },
    { label: "Coupons", href: "/seller/coupons", icon: TicketPercent },
  ] },
  { label: "Your shop", links: [
    { label: "Selling markets", href: "/seller#markets", icon: Globe2 },
    { label: "Seller Hub", href: "/seller/hub", icon: MessageSquareText },
    { label: "Team", href: "/seller/team", icon: Users },
    { label: "Finance", href: "/seller/finance", icon: ChartNoAxesCombined },
    { label: "Shop settings", href: "/seller/settings", icon: Settings2 },
  ] },
];

type MarketOption = { id: MarketId; name: string; currency: string; access: string; tone: string };

const delegatedNavigation: Record<string, SellerPermission[]> = {
  "/seller/hub": ["SUPPORT"],
  "/seller/finance": ["FINANCE_VIEW", "PAYOUT_REQUEST", "PAYOUT_DESTINATION"],
  "/seller/settings": ["PROFILE"],
  "/seller/listings": ["LISTINGS"],
  "/seller/reviews": ["LISTINGS"],
  "/seller/inventory": ["LISTINGS"],
  "/seller/orders": ["ORDER_PREPARATION"],
  "/seller/notifications": ["ORDER_PREPARATION"],
};

export function SellerScaffold({ children, shopName, initialMarket, options, permissions }: {
  children: ReactNode; shopName: string; initialMarket: MarketId; options: MarketOption[]; permissions?: SellerPermission[];
}) {
  const pathname = usePathname();
  const confirm = useConfirmTaxonomyNavigation();
  const dialog = useRef<HTMLDialogElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const market = options.find(option => option.id === initialMarket) || options[0];
  const href = (destination: string) => {
    const [path, section] = destination.split("#");
    return `${path}?market=${market.id}${section ? `#${section}` : ""}`;
  };
  const activeSection = (destination: string) => !destination.includes("#") &&
    (pathname === destination || destination !== "/seller" && pathname.startsWith(`${destination}/`));
  const sectionName = groups.flatMap(group => group.links).find(link => activeSection(link.href))?.label ?? "Shop";

  function openNavigation() {
    dialog.current?.showModal();
    closeButton.current?.focus();
  }

  function selectMarket(id: string) {
    if (id === market.id || !confirm()) return;
    const destination = new URL(window.location.href);
    if (pathname.startsWith("/seller/orders/")) destination.pathname = storefrontPath("/seller/orders");
    if (pathname.startsWith("/seller/cases/")) destination.pathname = storefrontPath("/seller/cases");
    destination.searchParams.set("market", id);
    destination.searchParams.delete("page");
    window.location.assign(destination);
  }

  const navigationGroups = permissions ? groups.map(group => ({ ...group, links: group.links.filter(link =>
    link.href === "/seller/team" || delegatedNavigation[link.href]?.some(permission => permissions.includes(permission))) }))
    .filter(group => group.links.length) : groups;
  const navigation = (mobile: boolean) => (
    <nav aria-label={mobile ? "Mobile seller navigation" : "Seller navigation"} className="seller-navigation">
      {navigationGroups.map(group => <div key={group.label} className="seller-navigation-group">
        <p>{group.label}</p>
        {group.links.map(({ href: destination, label, icon: Icon }) => (
          <Link key={destination} href={href(destination)} prefetch={false}
            aria-current={activeSection(destination) ? "page" : undefined}
            onClick={mobile ? () => dialog.current?.close() : undefined}>
            <Icon aria-hidden="true" size={18} strokeWidth={1.75} /><span>{label}</span>
          </Link>
        ))}
      </div>)}
    </nav>
  );

  const identity = <Link href={href(permissions ? "/seller/team" : "/seller")} className="seller-identity" prefetch={false}
    onClick={() => dialog.current?.close()}>
    <span className="seller-identity-icon"><Store size={20} aria-hidden="true" /></span>
    <span><strong>{shopName}</strong><small>Seller workspace</small></span>
  </Link>;

  return <div className="seller-workspace">
    <aside className="seller-sidebar">
      {identity}
      {navigation(false)}
      <Link className="seller-store-link" href="/shop" prefetch={false}>Go to storefront <ArrowUpRight size={15} aria-hidden="true" /></Link>
    </aside>
    <div className="seller-stage">
      <header className="seller-bar">
        <div className="seller-bar-context">
          <button ref={menuButton} type="button" className="seller-menu-toggle" aria-label="Open seller navigation"
            aria-haspopup="dialog" onClick={openNavigation}>
            <Menu size={21} aria-hidden="true" />
          </button>
          <div className="seller-crumbs" aria-label="Seller workspace location">
            <Link href={href("/seller")} prefetch={false}>Shop Manager</Link>
            <ChevronRight size={14} aria-hidden="true"/><span>{sectionName}</span>
          </div>
        </div>
        <div className="seller-bar-actions">
          <div className="seller-market-control">
            <label htmlFor="seller-market-switch"><Globe2 size={16} aria-hidden="true"/><span className="seller-visually-hidden">Active market</span></label>
            <select id="seller-market-switch" value={market.id} onChange={event => selectMarket(event.target.value)}>
              {options.map(option => <option key={option.id} value={option.id}>{option.name} · {option.currency}</option>)}
            </select>
            <ChevronDown size={13} aria-hidden="true"/>
          </div>
          <span className="seller-status seller-bar-approval" data-tone={market.tone}>{market.access}</span>
          <ShopperMenu />
        </div>
      </header>
      <div className="seller-content">{children}</div>
    </div>
    <dialog className="seller-mobile-drawer" ref={dialog} aria-label="Seller navigation" onClose={() => menuButton.current?.focus()}
      onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="seller-drawer-content">
        <div className="seller-drawer-header">
          {identity}
          <button ref={closeButton} type="button" aria-label="Close seller navigation" onClick={() => dialog.current?.close()}>
            <X size={21} aria-hidden="true"/>
          </button>
        </div>
        {navigation(true)}
        <Link className="seller-store-link" href="/shop" prefetch={false}>Go to storefront <ArrowUpRight size={15} aria-hidden="true" /></Link>
      </div>
    </dialog>
  </div>;
}
