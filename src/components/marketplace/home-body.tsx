import Image, { getImageProps } from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ComponentProps, CSSProperties } from "react";
import { storefrontPath } from "@/config/storefront-path";
import { formatMoney } from "@/config/markets";
import type { HomepageSection, HomepageTileLayout } from "@/lib/catalog/homepage-contract";
import type { ResolvedHomepageTile } from "@/lib/catalog/homepage-layout";
import type { CatalogImage, Collection, Department } from "@/lib/catalog/types";
import { ProductGrid } from "../product-grid";
import styles from "./home.module.css";

const previewHref = "#product-preview";
const mobileImageQuery = "(max-width: 650px)";
type ShoppingTile = Omit<ResolvedHomepageTile, "kind">;
type TileImageOptions = Pick<ShoppingTile, "mobileImage" | "focalPoint" | "mobileFocalPoint">;
type CropStyle = CSSProperties & { "--home-focal-point"?: string; "--home-mobile-focal-point"?: string };

function focalPosition(point: TileImageOptions["focalPoint"]) {
  return point ? `${point.x}% ${point.y}%` : undefined;
}

function EditorialImage({ asset, sizes, tile, decorative = false }: {
  asset: CatalogImage; sizes: string; tile?: TileImageOptions; decorative?: boolean;
}) {
  const mobile = tile?.mobileImage;
  const style: CropStyle | undefined = tile && {
    "--home-focal-point": focalPosition(tile.focalPoint),
    "--home-mobile-focal-point": focalPosition(tile.mobileFocalPoint) ?? (mobile ? "center" : undefined),
  };
  const options = { alt: decorative ? "" : asset.alt, fill: true, sizes };
  const image = <Image {...options} src={storefrontPath(asset.src)} className={tile ? styles.tileImage : undefined} style={style} />;
  if (!mobile) return image;
  const { props: source } = getImageProps({ ...options, src: storefrontPath(mobile.src) });
  return <picture className={styles.tilePicture}>
    <source media={mobileImageQuery} srcSet={source.srcSet ?? source.src} sizes={source.sizes} />
    {image}
  </picture>;
}

function CategoryShortcuts({ items, preview, label = "Category shortcuts", authored = false }: {
  items: readonly ShoppingTile[]; preview: boolean; label?: string; authored?: boolean;
}) {
  return <nav aria-label={label} className={styles.shortcuts}
    data-home-tile-layout={authored ? "shortcuts" : undefined}>
    <ul>{items.map(item => <li key={item.id}>
      <Link href={preview ? previewHref : item.href} prefetch={false}>
        <span className={styles.shortcutImage}>
          <EditorialImage asset={item.image} tile={authored ? item : undefined} sizes="68px" decorative />
        </span>
        <span>{item.title}</span>
      </Link>
    </li>)}</ul>
  </nav>;
}

function EditorialTiles({ items, layout, preview, market, authored = false }: {
  items: readonly ShoppingTile[]; layout: Exclude<HomepageTileLayout, "SHORTCUTS">; preview: boolean;
  market: ComponentProps<typeof ProductGrid>["market"]; authored?: boolean;
}) {
  const showcase = layout === "SHOWCASE";
  const discovery = layout === "DISCOVERY";
  const sizes = items.length === 1 ? "(max-width: 420px) 88vw, 360px"
    : showcase ? `(max-width: 540px) 94vw, (max-width: 840px) 46vw, ${items.length === 2 ? "690px" : "460px"}`
      : "(max-width: 347px) 94vw, (max-width: 1023px) 46vw, 340px";
  return <ul className={discovery ? styles.discoveryTiles : showcase ? styles.collectionTiles : styles.categoryTiles}
    data-home-tile-layout={authored ? layout.toLowerCase() : undefined}
    data-home-category-grid={layout === "PORTRAIT" || undefined} data-home-collection-grid={showcase || undefined}>
    {items.map(item => {
      const image = <EditorialImage asset={item.image} tile={authored ? item : undefined} sizes={sizes} />;
      const amount = item.product && formatMoney(item.product.amountMinor, market);
      const regular = item.product?.promotionEndsAt && item.product.regularMinor > item.product.amountMinor
        ? formatMoney(item.product.regularMinor, market) : undefined;
      const name = amount ? `${item.title}, ${amount}: ${item.ctaLabel}` : `${item.title}: ${item.ctaLabel}`;
      return <li key={item.id}>
        <Link className={discovery ? styles.discoveryTile : styles.tile} href={preview ? previewHref : item.href}
          prefetch={false} aria-label={name}>
          {discovery ? <span className={styles.discoveryVisual}>{image}</span> : image}
          <span className={styles.tileCopy}>
            <span className={styles.tileTitle}>{item.title}</span>
            {amount && <span className={styles.tilePrice}>{amount}{regular && <del>{regular}</del>}</span>}
            <span className={styles.tileAction}>{item.ctaLabel}<ArrowUpRight aria-hidden="true" size={15} strokeWidth={1.8} /></span>
          </span>
        </Link>
      </li>;
    })}
  </ul>;
}

export function HomeBodyHeading({ id, title, description, action, preview }: {
  id: string; title: string; description?: string; action?: HomepageSection["link"]; preview?: boolean;
}) {
  return <header className={styles.editorialHeading}>
    <div><h2 id={id}>{title}</h2>{description && <p>{description}</p>}</div>
    {action && <Link className={styles.editorialAction} href={preview ? previewHref : action.href} prefetch={false}
      aria-label={`${action.label}: ${title}`}>
      {action.label}<ArrowUpRight aria-hidden="true" size={15} strokeWidth={1.7} />
    </Link>}
  </header>;
}

export function HomeProductRow(props: ComponentProps<typeof ProductGrid>) {
  const count = props.cards.length;
  return <div className={styles.productRow} data-columns={count === 2 ? 2 : count === 3 || count === 6 ? 3 : 4}>
    <ProductGrid {...props} presentation="home" />
  </div>;
}

export function HomeBodySection({ section, heading, title, description, departments, collections, tiles, tileLayout, browseHref, preview, showShortcuts, ...grid }: {
  section: HomepageSection; heading: string; title: string; description?: string;
  departments?: readonly Department[]; collections?: readonly Collection[];
  tiles?: readonly ResolvedHomepageTile[]; tileLayout?: HomepageTileLayout;
  browseHref: (path: string) => string; preview: boolean; showShortcuts: boolean;
} & Pick<ComponentProps<typeof ProductGrid>, "cards" | "market" | "placement" | "linkForCard">) {
  const image = section.bannerImage;
  const spotlight = section.type === "CATEGORY_SPOTLIGHT" && image;
  const header = <HomeBodyHeading id={heading} title={title} description={description} action={section.link} preview={preview} />;
  if (section.type === "BENEFITS") {
    return <>
      {header}
      <ul className={styles.serviceBenefits}>
        {section.benefits?.map(({ title, description, destination }, index) => <li key={index}>
          <h3>{title}</h3><p>{description}</p>
          {destination && <Link href={preview ? previewHref : browseHref(`/help/${destination}`)} prefetch={false}
            className={styles.editorialAction} aria-label={`Learn more about ${title}`}>
            Learn more <ArrowUpRight aria-hidden="true" size={14} />
          </Link>}
        </li>)}
      </ul>
    </>;
  }
  const banner = image && <div className={styles.editorialBanner}><EditorialImage asset={image} sizes="(max-width: 1240px) 96vw, 1400px" /></div>;
  const categoryTiles = departments?.map(({ id, slug, name, image }) => ({ id, title: name, ctaLabel: "View all", image,
    href: browseHref(`/departments/${encodeURIComponent(slug)}`) })) ?? [];
  const collectionTiles = collections?.flatMap(({ id, slug, name, image }) => image ? [{ id, title: name, ctaLabel: "Shop collection", image,
    href: browseHref(`/collections/${encodeURIComponent(slug)}`) }] : []) ?? [];
  const items = tiles ?? (categoryTiles.length ? categoryTiles : collectionTiles);
  const layout = tileLayout ?? (categoryTiles.length ? "PORTRAIT" : "SHOWCASE");
  const singleFeature = items.length === 1 && !image && (layout === "PORTRAIT" || layout === "SHOWCASE");
  return <>
    {showShortcuts && <CategoryShortcuts items={categoryTiles} preview={preview} />}
    {spotlight ? <div className={styles.spotlight}>
      <div className={styles.spotlightVisual}><EditorialImage asset={spotlight} sizes="(max-width: 650px) 96vw, 710px" /></div>
      <div className={styles.spotlightCopy}>{header}</div>
    </div> : <div className={singleFeature ? styles.singleFeature : undefined}>
      {header}
      {banner}
      {items.length > 0 && (layout === "SHORTCUTS"
        ? <CategoryShortcuts items={items} label={title} preview={preview} authored />
        : <EditorialTiles items={items} layout={layout} preview={preview} market={grid.market} authored={Boolean(tileLayout)} />)}
    </div>}
    {grid.cards.length > 0 && <HomeProductRow {...grid} preview={preview} />}
  </>;
}
