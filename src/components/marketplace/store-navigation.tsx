"use client";

import { ArrowUpRight, ChevronDown, ChevronRight, Compass, Heart, House, Menu, ShoppingBag, Tag, UserRound } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { MarketId } from "@/config/markets";
import { marketStoreHref, withoutRegionalPrefix } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";
import type { DepartmentNode } from "@/lib/catalog/departments";
import { useCartPricing } from "../cart-pricing";
import { useDismissOutside } from "./use-dismiss-outside";

function CategoryLinks({ departments, close, region }: { departments: readonly DepartmentNode[]; close: () => void; region?: MarketId }) {
  return <ul className="mp-category-children">
    {departments.map(category => <li key={category.id}>
      <Link href={marketStoreHref(`/departments/${category.slug}`, region)} onClick={close}>{category.shortName}</Link>
      {category.children.length > 0 && <CategoryLinks departments={category.children} close={close} region={region} />}
    </li>)}
  </ul>;
}

function CategoryPanel({ departments, active, select, close, id, region }: {
  departments: readonly DepartmentNode[];
  active: DepartmentNode | undefined;
  select: (id: string) => void;
  close: () => void;
  id?: string;
  region?: MarketId;
}) {
  return (
    <nav id={id} className="mp-category-panel" aria-label="Browse categories">
      <div className="mp-category-menu-intro">
        <strong>Categories</strong>
        <Link href={marketStoreHref("/shop", region)} onClick={close}>Shop all <ArrowUpRight size={15} aria-hidden="true" /></Link>
      </div>
      {active && <div className="mp-category-mega">
        <ul className="mp-category-parents">
          {departments.map(department => (
            <li key={department.id}>
              <button type="button" aria-pressed={active.id === department.id}
                onPointerEnter={event => { if (event.pointerType === "mouse") select(department.id); }}
                onClick={() => select(department.id)}>
                {department.shortName}<ChevronRight size={15} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <div className="mp-category-sections">
          <Link className="mp-category-overview" href={marketStoreHref(`/departments/${active.slug}`, region)} onClick={close}>
            See all {active.shortName}<ArrowUpRight size={14} aria-hidden="true" />
          </Link>
          {active.children.length > 0 ? <ul className="mp-category-menu-grid">
            {active.children.map(category => <li key={category.id}>
              <Link href={marketStoreHref(`/departments/${category.slug}`, region)} onClick={close}>
                <Image src={storefrontPath(category.image.src)} alt="" width={42} height={42} />
                {category.shortName}
              </Link>
              {category.children.length > 0 && <CategoryLinks departments={category.children} close={close} region={region} />}
            </li>)}
          </ul> : <Link className="mp-category-image" href={marketStoreHref(`/departments/${active.slug}`, region)} onClick={close} aria-label={`Shop ${active.shortName}`}>
            <Image src={storefrontPath(active.image.src)} alt="" width={236} height={102} />
          </Link>}
        </div>
      </div>}
    </nav>
  );
}

export function StoreCategoryMenu({ departments, region }: { departments: readonly DepartmentNode[]; region?: MarketId }) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const [selected, select] = useState<string>();
  const active = departments.find(department => department.id === selected) ?? departments[0];

  const close = useCallback(() => {
    if (disclosure.current?.open) disclosure.current.open = false;
  }, []);
  useDismissOutside(disclosure, close);

  return (
    <details
      ref={disclosure}
      className="department-menu mp-store-categories"
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
      <CategoryPanel departments={departments} active={active} select={select} close={close} region={region} />
    </details>
  );
}

export function StoreShopNavigation({ departments, showShops, dealLabel, region }: {
  departments: readonly DepartmentNode[];
  showShops: boolean;
  dealLabel: string;
  region?: MarketId;
}) {
  const panelId = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLAnchorElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ triggerId: string; selectedId: string; focus?: boolean }>();
  const active = departments.find(department => department.id === menu?.selectedId);
  const open = Boolean(active);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (panel.current?.contains(document.activeElement)) trigger.current?.focus();
      setMenu(undefined);
    }
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [open]);

  useEffect(() => {
    if (menu?.focus) panel.current?.querySelector<HTMLAnchorElement>(".mp-category-overview")?.focus();
  }, [menu]);

  const close = useCallback(() => setMenu(undefined), []);
  useDismissOutside(container, close, open);

  return (
    <div ref={container} className="shell mp-shop-navigation" onPointerLeave={event => {
      if (event.pointerType === "mouse" && !panel.current?.contains(document.activeElement)) close();
    }}>
      <nav className="mp-nav" aria-label="Shop navigation">
        <Link href={marketStoreHref("/shop", region)} onPointerEnter={close} onFocus={close} onClick={close}>Shop all</Link>
        <Link href={marketStoreHref("/shop?sort=newest", region)} onPointerEnter={close} onFocus={close} onClick={close}>New arrivals</Link>
        <Link className="mp-shop-deals" href={marketStoreHref("/shop?offer=sale", region)} onPointerEnter={close} onFocus={close} onClick={close}>
          <Tag size={16} aria-hidden="true" /> {dealLabel}
        </Link>
        {departments.map(department => {
          const expanded = menu?.triggerId === department.id;
          return <Link key={department.id} href={marketStoreHref(`/departments/${department.slug}`, region)} aria-expanded={expanded}
            aria-controls={expanded ? panelId : undefined}
            onPointerEnter={event => {
              if (event.pointerType !== "mouse") return;
              trigger.current = event.currentTarget;
              setMenu({ triggerId: department.id, selectedId: department.id });
            }}
            onKeyDown={event => {
              if (event.key !== "ArrowDown") return;
              event.preventDefault();
              trigger.current = event.currentTarget;
              setMenu({ triggerId: department.id, selectedId: department.id, focus: true });
            }}
            onClick={close}>
            {department.shortName}
          </Link>;
        })}
        {showShops && <Link href={marketStoreHref("/shops", region)} onPointerEnter={close} onFocus={close} onClick={close}>Shops</Link>}
      </nav>
      {active && <div ref={panel} className="mp-shop-category-panel">
        <CategoryPanel id={panelId} departments={departments} active={active} close={close} region={region}
          select={id => setMenu(current => current && { triggerId: current.triggerId, selectedId: id })} />
      </div>}
    </div>
  );
}

const tabs = [
  { label: "Home", href: "/", icon: House },
  { label: "Browse", href: "/shop", icon: Compass },
  { label: "Saved", href: "/favorites", icon: Heart },
  { label: "Cart", href: "/cart", icon: ShoppingBag },
  { label: "Account", href: "/account", icon: UserRound },
] as const;

export function MobileStoreNav({ region }: { region?: MarketId }) {
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
                href={marketStoreHref(href, region)}
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
