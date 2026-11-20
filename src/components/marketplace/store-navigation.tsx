"use client";

import { ArrowUpRight, ChevronDown, ChevronRight, Compass, Heart, House, Menu, ShoppingBag, Tag, UserRound } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { MarketId } from "@/config/markets";
import { withoutRegionalPrefix } from "@/config/regional-path";
import { storefrontBasePath, storefrontPath } from "@/config/storefront-path";
import type { StorefrontCategoryLink, StorefrontNavigation, StorefrontNavLink } from "@/lib/catalog/storefront-navigation";
import { useCartPricing } from "../cart-pricing";
import { MeasuredCategoryLink } from "../measurement-observers";

function navigationPath(href: string) {
  const pathname = href.split(/[?#]/, 1)[0];
  const scoped = storefrontBasePath && pathname.startsWith(storefrontBasePath + "/") ? pathname.slice(storefrontBasePath.length) : pathname;
  const bare = withoutRegionalPrefix(scoped).replace(/\/$/, "") || "/";
  try { return decodeURIComponent(bare); } catch { return bare; }
}

function categoryPage(category: StorefrontCategoryLink, current: string) {
  return current === navigationPath(category.href) || current === navigationPath(category.canonicalHref);
}

function currentCategory(category: StorefrontCategoryLink, current: string): boolean {
  return categoryPage(category, current) || category.children.some(child => currentCategory(child, current));
}

function NavLink({ link, current, marketId, close, className, children, position }: {
  link: Omit<StorefrontNavLink, "id">;
  current: string;
  marketId: MarketId;
  close?: () => void;
  className?: string;
  children?: React.ReactNode;
  position?: number;
}) {
  const extraQuery = [...new URLSearchParams(link.href.split("?")[1]).keys()].some(key => key !== "market" && key !== "lang");
  const exact = link.category ? categoryPage(link.category, current) : !extraQuery && current === navigationPath(link.href);
  const active = exact || Boolean(link.category && currentCategory(link.category, current));
  const props = {
    href: link.href, onClick: close, className, prefetch: false as const,
    "aria-current": exact ? "page" as const : undefined, "data-active": active || undefined,
  };
  return link.category ? <MeasuredCategoryLink {...props} categoryId={link.category.id} marketId={marketId}
    context={{ placement: "category-navigation", position }}>{children ?? link.label}</MeasuredCategoryLink>
    : <Link {...props}>{children ?? link.label}</Link>;
}

export function StoreNavigationBar({ navigation, marketId, className, label }: {
  navigation: StorefrontNavigation; marketId: MarketId; className: string; label: string;
}) {
  const current = navigationPath(usePathname());
  if (!navigation.links.length) return null;
  return <nav className={`${className} store-navigation-bar`} aria-label={label}>
    {navigation.links.map((link, index) => <NavLink key={link.id} link={link} current={current} marketId={marketId} position={index + 1}
      className={link.sale ? "mp-shop-deals" : undefined}>
      {link.sale && <Tag size={16} aria-hidden="true" />}{link.label}
    </NavLink>)}
  </nav>;
}

type MenuLinksContext = { current: string; marketId: MarketId; close: () => void };

function CategoryLinks({ categories, ...context }: { categories: readonly StorefrontCategoryLink[] } & MenuLinksContext) {
  return <ul className="mp-category-children">
    {categories.map(category => <li key={category.id}>
      <NavLink link={{ ...category, category }} {...context} />
      {category.children.length > 0 && <CategoryLinks categories={category.children} {...context} />}
    </li>)}
  </ul>;
}

function MobileMenuLinks({ links, ...context }: { links: StorefrontNavLink[] } & MenuLinksContext) {
  return <ul className="store-category-mobile">
    {links.map(link => <li key={link.id}>
      {link.category && link.category.children.length > 0 ? <details>
        <summary>{link.label}<ChevronDown size={16} aria-hidden="true" /></summary>
        <NavLink link={link} {...context}>See all {link.label}</NavLink>
        <CategoryLinks categories={link.category.children} {...context} />
      </details> : <NavLink link={link} {...context} />}
    </li>)}
  </ul>;
}

export function StoreCategoryMenu({ navigation, marketId }: { navigation: StorefrontNavigation; marketId: MarketId }) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const current = navigationPath(usePathname());
  const [selected, select] = useState<string>();
  const categories = navigation.links.flatMap(link => link.category ? [{ ...link, category: link.category }] : []);
  const shortcuts = navigation.links.filter(link => !link.category && (navigation.managed || link.id !== "shop"));
  const active = categories.find(link => link.id === selected) ??
    categories.find(link => currentCategory(link.category, current)) ?? categories[0];
  const shop = !navigation.managed && navigation.links.find(link => link.id === "shop");

  function close() {
    if (disclosure.current) disclosure.current.open = false;
  }

  useEffect(() => {
    function closeOutside(event: PointerEvent) {
      if (disclosure.current?.open && event.target instanceof Node && !disclosure.current.contains(event.target)) {
        disclosure.current.open = false;
      }
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  const context = { current, marketId, close };

  return (
    <details
      ref={disclosure}
      className="department-menu mp-store-categories"
      onToggle={event => { if (!event.currentTarget.open) select(undefined); }}
      onBlur={event => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close();
      }}
      onKeyDown={event => {
        if (event.key === "Escape" && event.currentTarget.open) {
          close();
          trigger.current?.focus();
        }
      }}
    >
      <summary ref={trigger} aria-label="Categories">
        <Menu size={19} aria-hidden="true" />
        <span>Categories</span>
        <ChevronDown size={14} className="mp-category-chevron" aria-hidden="true" />
      </summary>
      <nav aria-label="Browse categories">
        <div className="mp-category-menu-intro">
          <strong>Categories</strong>
          {shop && <NavLink link={shop} {...context}>Shop all <ArrowUpRight size={15} aria-hidden="true" /></NavLink>}
        </div>
        {!navigation.links.length && <p className="store-category-empty">Use search to find products in this market.</p>}
        <div className="store-category-desktop">
          {active && <div className="mp-category-mega">
            <ul className="mp-category-parents">
              {categories.map(link => (
                <li key={link.id}>
                  <button type="button" aria-pressed={active.id === link.id}
                    onPointerEnter={event => { if (event.pointerType === "mouse") select(link.id); }}
                    onClick={() => select(link.id)}>
                    {link.label}<ChevronRight size={15} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="mp-category-sections">
              <NavLink className="mp-category-overview" link={active} {...context}>
                See all {active.label}<ArrowUpRight size={14} aria-hidden="true" />
              </NavLink>
              {active.category.children.length > 0 ? <ul className="mp-category-menu-grid">
                {active.category.children.map(category => <li key={category.id}>
                  <NavLink link={{ ...category, category }} {...context}>
                    <Image src={storefrontPath(category.image.src)} alt="" width={42} height={42} />
                    {category.label}
                  </NavLink>
                  {category.children.length > 0 && <CategoryLinks categories={category.children} {...context} />}
                </li>)}
              </ul> : <div className="mp-category-image">
                <Image src={storefrontPath(active.category.image.src)} alt="" width={236} height={102} />
              </div>}
            </div>
          </div>}
          {shortcuts.length > 0 && <ul className="store-category-shortcuts">
            {shortcuts.map(link => <li key={link.id}><NavLink link={link} {...context} /></li>)}
          </ul>}
        </div>
        <MobileMenuLinks links={navigation.links.filter(link => navigation.managed || link.id !== "shop")} {...context} />
      </nav>
    </details>
  );
}

const tabs = [
  { label: "Home", href: "/", icon: House },
  { label: "Browse", href: "/shop", icon: Compass },
  { label: "Saved", href: "/favorites", icon: Heart },
  { label: "Cart", href: "/cart", icon: ShoppingBag },
  { label: "Account", href: "/account", icon: UserRound },
] as const;

export function MobileStoreNav() {
  const pathname = withoutRegionalPrefix(usePathname());
  const { totalSaved } = useCartPricing();
  if (/^\/(?:admin|checkout|seller|staff)(?:\/|$)/.test(pathname)) return null;

  const area = pathname.split("/")[1];
  const relatedSections = ["departments", "products", "collections", "search", "gifts", "shops"];
  return (
    <nav aria-label="Mobile shopping" className="mp-mobile-nav">
      <ul>
        {tabs.map(({ href, label, icon: Icon }) => {
          const isCurrent = pathname === href;
          const selected = isCurrent ||
            (href !== "/" && pathname.startsWith(`${href}/`)) ||
            (href === "/shop" && relatedSections.includes(area)) ||
            (href === "/account" && (area === "orders" || area === "messages"));
          const count = href === "/cart" ? totalSaved : 0;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={isCurrent ? "page" : undefined}
                aria-label={count ? `Cart, ${count} ${count === 1 ? "item" : "items"}` : undefined}
                data-selected={selected || undefined}
              >
                <span className="mp-mobile-nav-icon">
                  <Icon size={21} strokeWidth={selected ? 2.25 : 1.8} aria-hidden="true" />
                  {count > 0 && <span className="mp-mobile-nav-count" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
                </span>
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
