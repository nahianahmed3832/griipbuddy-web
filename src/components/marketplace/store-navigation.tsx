"use client";

import { ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, Compass, Heart, House, Menu, ShoppingBag, Tag, UserRound, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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

function MobileMenuLinks({ links, trail, onTrailChange, ...context }: {
  links: StorefrontNavLink[];
  trail: string[];
  onTrailChange: (trail: string[]) => void;
} & MenuLinksContext) {
  const back = useRef<HTMLButtonElement>(null);
  const branchButtons = useRef(new Map<string, HTMLButtonElement>());
  const focus = useRef<{ id: string } | "back" | null>(null);
  const path: StorefrontNavLink[] = [];
  let rows = links;
  for (const id of trail) {
    const branch = rows.find(row => row.id === id);
    if (!branch?.category?.children.length) break;
    path.push(branch);
    rows = branch.category.children.map(category => ({ ...category, category }));
  }
  const active = path.at(-1);

  useLayoutEffect(() => {
    if (focus.current === "back") back.current?.focus();
    else if (focus.current) branchButtons.current.get(focus.current.id)?.focus();
    focus.current = null;
  }, [trail]);

  return <div className="store-category-mobile">
    {active && <div className="store-category-mobile-branch">
      <button ref={back} type="button" className="store-category-back" onClick={() => {
        focus.current = { id: active.id };
        onTrailChange(path.slice(0, -1).map(row => row.id));
      }}><ChevronLeft size={18} aria-hidden="true" />Back</button>
      <h2>{active.label}</h2>
      <NavLink link={active} {...context}>See all {active.label}<ArrowUpRight size={15} aria-hidden="true" /></NavLink>
    </div>}
    <ul>
      {rows.map((link, index) => <li key={link.id} className="store-category-mobile-row">
        <NavLink link={link} {...context} position={index + 1} />
        {!!link.category?.children.length && <button type="button" className="store-category-expand"
          aria-label={`Browse ${link.label} subcategories`}
          ref={button => {
            if (button) branchButtons.current.set(link.id, button);
            else branchButtons.current.delete(link.id);
          }} onClick={() => {
            focus.current = "back";
            onTrailChange([...path.map(row => row.id), link.id]);
          }}><ChevronRight size={19} aria-hidden="true" /></button>}
      </li>)}
    </ul>
  </div>;
}

export function StoreCategoryMenu({ navigation, marketId }: { navigation: StorefrontNavigation; marketId: MarketId }) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const sections = useRef<HTMLElement>(null);
  const focusSections = useRef(false);
  const panelId = useId();
  const current = navigationPath(usePathname());
  const [selected, select] = useState<string>();
  const [trail, setTrail] = useState<string[]>([]);
  const shop = !navigation.managed && navigation.links.find(link => link.id === "shop");
  const links = navigation.links.filter(link => link !== shop);
  const categories = links.flatMap(link => link.category?.children.length ? [{ ...link, category: link.category }] : []);
  const active = categories.find(link => link.id === selected) ??
    categories.find(link => currentCategory(link.category, current)) ?? categories[0];

  useLayoutEffect(() => {
    if (focusSections.current) sections.current?.querySelector("a")?.focus();
    focusSections.current = false;
  }, [active?.id]);

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
      onToggle={event => {
        if (!event.currentTarget.open) {
          select(undefined);
          setTrail([]);
        }
      }}
      onBlur={event => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close();
      }}
      onKeyDown={event => {
        if (event.key === "Escape" && event.currentTarget.open) {
          event.preventDefault();
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
          <button type="button" className="store-category-close" aria-label="Close categories" onClick={() => {
            close();
            trigger.current?.focus();
          }}><X size={19} aria-hidden="true" /></button>
        </div>
        {!navigation.links.length && <p className="store-category-empty">Use search to find products in this market.</p>}
        {links.length > 0 && <div className="store-category-desktop">
          <div className="mp-category-mega" data-subcategories={Boolean(active)}>
            <ul className="mp-category-parents">
              {links.map((link, index) => (
                <li key={link.id}>
                  {link.category?.children.length ? <button type="button" aria-expanded={active?.id === link.id} aria-controls={panelId}
                    data-active={currentCategory(link.category, current) || undefined}
                    onPointerEnter={event => {
                      if (event.pointerType === "mouse" && !sections.current?.contains(document.activeElement)) select(link.id);
                    }}
                    onClick={event => {
                      if (event.detail === 0) {
                        if (active?.id === link.id) sections.current?.querySelector("a")?.focus();
                        else focusSections.current = true;
                      }
                      select(link.id);
                    }}>
                    {link.label}<ChevronRight size={15} aria-hidden="true" />
                  </button> : <NavLink link={link} {...context} position={index + 1} />}
                </li>
              ))}
            </ul>
            {active && <section className="mp-category-sections" id={panelId} ref={sections} aria-label={`Subcategories of ${active.label}`}>
              <NavLink className="mp-category-overview" link={active} {...context} position={links.findIndex(link => link.id === active.id) + 1}>
                See all {active.label}<ArrowUpRight size={14} aria-hidden="true" />
              </NavLink>
              <ul className="mp-category-menu-grid">
                {active.category.children.map((category, index) => <li key={category.id}>
                  <NavLink link={{ ...category, category }} {...context} position={index + 1}>
                    <Image src={storefrontPath(category.image.src)} alt="" width={42} height={42} />
                    {category.label}
                  </NavLink>
                  {category.children.length > 0 && <CategoryLinks categories={category.children} {...context} />}
                </li>)}
              </ul>
            </section>}
          </div>
        </div>}
        {links.length > 0 && <MobileMenuLinks links={links} {...context} trail={trail} onTrailChange={setTrail} />}
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
