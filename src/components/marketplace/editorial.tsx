import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { storefrontPath } from "@/config/storefront-path";
import { catalogBrowseHref } from "@/lib/catalog/category-browse-links";
import { catalogRobots } from "@/lib/catalog/catalog-seo";
import { editorialImageSource, editorialPath, publishedEditorial } from "@/lib/catalog/editorial";
import type { EditorialDocument } from "@/lib/catalog/editorial-contract";
import type { MarketConfiguration } from "@/lib/market-config";
import { currentMarket } from "@/lib/market-server";
import { canonicalUrl, hybridDemoMode } from "@/lib/release-config";
import styles from "./editorial.module.css";

const routeContext = (market: MarketConfiguration) => ({ id: market.id, locale: market.locale, regional: hybridDemoMode() });

export async function findEditorial(kind: EditorialDocument["kind"], slug: string) {
  const market = await currentMarket();
  const content = await publishedEditorial(market.id, market.locale);
  const document = content.documents.find(item => item.kind === kind && item.slug === slug);
  return { market, document, category: content.categories.find(item => item.slug === document?.category) };
}

export function editorialMetadata(document: EditorialDocument | undefined, market: MarketConfiguration): Metadata {
  if (!document) return {};
  const title = document.seoTitle ?? document.title;
  const description = document.seoDescription ?? document.summary;
  const context = { id: market.id, locale: market.locale, regional: false };
  const robots = catalogRobots(context);
  const canonical = robots ? undefined : canonicalUrl(catalogBrowseHref(editorialPath(document), context));
  return { title, description, robots, alternates: canonical ? { canonical } : undefined, openGraph: { title, description } };
}

export function EditorialDetail({ document, market, category }: {
  document: EditorialDocument; market: MarketConfiguration; category?: { label: string; slug: string };
}) {
  const source = editorialImageSource(document, market.id, market.locale);
  const back = category ? new URLSearchParams({ category: category.slug }) : undefined;
  return <article className={`shell ${styles.detail}`} lang={market.locale}>
    <nav aria-label="Breadcrumb" className={styles.breadcrumb}>
      <Link href={catalogBrowseHref("/", routeContext(market))}>Home</Link>
      {document.kind === "ARTICLE" && <Link href={catalogBrowseHref("/blog", routeContext(market), back)}>{category?.label ?? "Blog"}</Link>}
    </nav>
    <header>
      <h1 className="display-type">{document.title}</h1>
      <p className={styles.lede}>{document.summary}</p>
    </header>
    {source && document.image && <div className={styles.cover}>
      <Image src={storefrontPath(source)} alt={document.image.alt} fill sizes="(max-width: 800px) 94vw, 780px" unoptimized={source.startsWith("/media/")} />
    </div>}
    <div className={styles.prose}>{document.body.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
  </article>;
}

export function EditorialIndex({ market, content, term, category, page }: {
  market: MarketConfiguration; content: Awaited<ReturnType<typeof publishedEditorial>>; term: string; category: string; page: number;
}) {
  const activeArticles = content.documents.filter(document => document.kind === "ARTICLE");
  const availableCategories = content.categories.filter(item => activeArticles.some(article => article.category === item.slug));
  const normalizedTerm = term.toLocaleLowerCase(market.locale);
  const matches = activeArticles.filter(item => (!category || item.category === category) &&
    (!normalizedTerm || [item.title, item.summary].some(value => value.toLocaleLowerCase(market.locale).includes(normalizedTerm))));
  const pageSize = 8;
  const total = Math.max(1, Math.ceil(matches.length / pageSize));
  const current = Math.min(page, total);
  const items = matches.slice((current - 1) * pageSize, current * pageSize);
  const pages = content.documents.filter(document => document.kind === "PAGE");
  const route = routeContext(market);
  const pageLink = (value: number) => catalogBrowseHref("/blog", route,
    new URLSearchParams({ ...(term && { q: term }), ...(category && { category }), page: String(value) }));
  const blogPath = catalogBrowseHref("/blog", route).split("?")[0];
  return <div className={`shell ${styles.index}`} lang={market.locale}>
    <header><h1 className="display-type">Blog</h1></header>
    {activeArticles.length > 0 && <form action={storefrontPath(blogPath)} method="get" className={styles.filters}>
      <input type="hidden" name="market" value={market.id}/><input type="hidden" name="lang" value={market.locale}/>
      <label>Search articles<input name="q" type="search" defaultValue={term} maxLength={100}/></label>
      {availableCategories.length > 0 && <label>Category<select name="category" defaultValue={category}>
        <option value="">All categories</option>
        {availableCategories.map(item => <option key={item.slug} value={item.slug}>{item.label}</option>)}
      </select></label>}
      <button type="submit" className="button button--primary">Search</button>
      {(term || category) && <Link href={catalogBrowseHref("/blog", route)}>Clear filters</Link>}
    </form>}
    {items.length ? <ul className={styles.articles}>{items.map(item => {
      const source = editorialImageSource(item, market.id, market.locale);
      return <li key={item.id}><article className={styles.card}>
        {source && item.image && <div className={styles.cover}>
          <Image src={storefrontPath(source)} alt={item.image.alt} fill sizes="(max-width: 700px) 90vw, 420px" unoptimized={source.startsWith("/media/")} />
        </div>}
        <div>
          <h2><Link href={catalogBrowseHref(editorialPath(item), route)}>{item.title}</Link></h2>
          <p>{item.summary}</p>
        </div>
      </article></li>;
    })}</ul> : <p className={styles.empty}>{activeArticles.length ? "No articles match these filters." : "There are no published articles in this market and language."}</p>}
    {total > 1 && <nav className={styles.pagination} aria-label="Blog pages">
      {current > 1 && <Link href={pageLink(current - 1)}>Previous page</Link>}
      <span>Page {current} of {total}</span>
      {current < total && <Link href={pageLink(current + 1)}>Next page</Link>}
    </nav>}
    {pages.length > 0 && <section aria-labelledby="editorial-pages">
      <h2 id="editorial-pages">Store information</h2>
      <ul>{pages.map(item => <li key={item.id}><Link href={catalogBrowseHref(editorialPath(item), route)}>{item.title}</Link></li>)}</ul>
    </section>}
  </div>;
}
