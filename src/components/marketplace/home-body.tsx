import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ComponentProps } from "react";
import { storefrontPath } from "@/config/storefront-path";
import type { HomepageSection } from "@/lib/catalog/homepage-contract";
import type { CatalogImage, Collection, Department } from "@/lib/catalog/types";
import { ProductGrid } from "../product-grid";
import styles from "./home.module.css";

const previewHref = "#product-preview";

function EditorialImage({ asset, sizes }: { asset: CatalogImage; sizes: string }) {
  return <Image src={storefrontPath(asset.src)} alt={asset.alt} fill sizes={sizes} />;
}

function EditorialTiles({ items, collections, preview }: {
  items: readonly { id: string; name: string; image: CatalogImage; href: string }[];
  collections?: boolean;
  preview: boolean;
}) {
  return <ul className={collections ? styles.collectionTiles : styles.categoryTiles}>
    {items.map((item, index) => <li key={item.id}>
      <Link className={styles.tile} href={preview ? previewHref : item.href} prefetch={false} aria-label={item.name}>
        <span className={styles.tileVisual}><EditorialImage asset={item.image} sizes={collections
          ? `(max-width: 540px) ${index === 0 && items.length % 2 === 1 ? "96vw" : "46vw"}, (max-width: 840px) 48vw, ${items.length === 2 ? "600px" : "400px"}`
          : "(max-width: 480px) 45vw, (max-width: 820px) 30vw, 210px"} /></span>
        <span className={styles.tileLabel}>{item.name}<ArrowUpRight aria-hidden="true" size={16} strokeWidth={1.7} /></span>
      </Link>
    </li>)}
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

export function HomeBodySection({ section, heading, title, description, departments, collections, browseHref, preview, ...grid }: {
  section: HomepageSection; heading: string; title: string; description?: string;
  departments?: readonly Department[]; collections?: readonly Collection[];
  browseHref: (path: string) => string; preview: boolean;
} & Pick<ComponentProps<typeof ProductGrid>, "cards" | "market" | "placement" | "linkForCard">) {
  const image = section.bannerImage;
  const spotlight = section.type === "CATEGORY_SPOTLIGHT" && image;
  const header = <HomeBodyHeading id={heading} title={title} description={description} action={section.link} preview={preview} />;
  return <>
    {spotlight ? <div className={styles.spotlight}>
      <div className={styles.spotlightVisual}><EditorialImage asset={spotlight} sizes="(max-width: 650px) 96vw, 710px" /></div>
      <div className={styles.spotlightCopy}>{header}</div>
    </div> : <>
      {header}
      {image && <div className={styles.editorialBanner}><EditorialImage asset={image} sizes="(max-width: 1240px) 96vw, 1208px" /></div>}
    </>}
    {departments && <EditorialTiles preview={preview} items={departments.map(({ id, slug, name, image }) => ({ id, name, image,
      href: browseHref(`/departments/${encodeURIComponent(slug)}`) }))} />}
    {collections && <EditorialTiles collections preview={preview} items={collections.flatMap(({ id, slug, name, image }) => image ? [{ id, name, image,
      href: browseHref(`/collections/${encodeURIComponent(slug)}`) }] : [])} />}
    {grid.cards.length > 0 && <HomeProductRow {...grid} preview={preview} />}
  </>;
}
