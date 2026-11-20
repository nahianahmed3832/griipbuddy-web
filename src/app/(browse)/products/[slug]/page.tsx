import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ProductDetail } from "@/components/product-detail";
import { ConnectedProductDetail } from "@/components/connected-product-detail";
import { ConnectedProductGallery } from "@/components/connected-product-gallery";
import { CatalogJsonLd } from "@/components/catalog-json-ld";
import type { ProductDeliveryChoice } from "@/components/connected-product-delivery";
import { ProductGrid } from "@/components/product-grid";
import { Breadcrumbs, SectionHeading } from "@/components/store-ui";
import { productCards, type SearchParams } from "@/lib/catalog/listing";
import { catalogDevices } from "@/lib/catalog/devices";
import { catalog } from "@/lib/catalog/repository";
import { currentMarket } from "@/lib/market-server";
import { firstPartyStoreMode, hybridDemoMode, marketplaceMode } from "@/lib/release-config";
import { formatMoney, type Market, type MarketId } from "@/config/markets";
import { merchantProductUrl } from "@/lib/catalog/merchant-fields";
import { isMerchantBdPreviewProduct, merchantBdPreviewPageProduct } from "@/lib/catalog/merchant-bd-preview";
import { devLiveBangladeshFeed, merchantFeedSettings } from "@/lib/catalog/merchant-feed-config";
import { breadcrumbMetadata, connectedProductMetadata, productMetadata } from "@/lib/catalog/product-metadata";
import { catalogAbsoluteUrl, catalogRobots, productSeoAlternates } from "@/lib/catalog/catalog-seo";
import { ProductQuestion, ProductReviews } from "@/components/product-engagement";
import { WhatsAppHandoff } from "@/components/whatsapp-handoff";
import { whatsAppProductInquiry } from "@/lib/notifications/whatsapp";
import { ConnectedCatalogCards } from "@/components/connected-catalog-browse";
import { CompareProduct } from "@/components/product-comparison";
import { RecentlyViewedLink, RecentlyViewedProduct } from "@/components/marketplace/recent";
import type { ProductAddOn } from "@/components/retail-product";
import { getDb } from "@/lib/db/client";
import { getShopper } from "@/lib/marketplace/auth";
import { variantWatchSettings } from "@/lib/marketplace/variant-watches";
import { deliveryChoices, marketHasDelivery } from "@/lib/commerce/orders";
import { contiguousStates } from "@/lib/commerce/address";
import { integratedCheckout } from "@/lib/commerce/integrated-checkout";
import { paypalCheckoutAvailability } from "@/lib/commerce/paypal-config";
import { validVariantId } from "@/lib/cart/model";
import { eligibleHomeProducts } from "@/lib/catalog/homepage-layout";
import { loadRecommendations } from "@/lib/catalog/recommendations";
import { recommendationConfig } from "@/lib/catalog/recommendation-config";
import { reportFailure } from "@/lib/db/observability";
import { browseProductSelection, catalogBrowseHref, catalogProductHref, matchesBrowseProductSelection } from "@/lib/catalog/category-browse-links";
import { connectedCategoryDetail } from "@/lib/catalog/connected-navigation";
import { getConnectedProduct } from "@/lib/catalog/connected-product";
import { CatalogApiError, catalogVariantWhere } from "@/lib/catalog/connected-public";
import { listConnectedCatalog } from "@/lib/catalog/connected-listing";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };
type ConnectedProduct = NonNullable<Awaited<ReturnType<typeof getConnectedProduct>>>;
type ProductCrumb = { label: string; href: string };

function primaryCrumbs(categories: readonly { name: string; slug: string; localizedSlug?: string }[], market: Market): ProductCrumb[] {
  const context = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
  return categories.map(category => ({ label: category.name,
    href: catalogBrowseHref(`/departments/${encodeURIComponent(category.localizedSlug ?? category.slug)}`, context) }));
}

const connectedForPage = cache(async (slug: string, marketId: MarketId, locale: string) => {
  try {
    return await getConnectedProduct(slug, { marketId, locale });
  } catch (error) {
    if (error instanceof CatalogApiError && error.code === "invalid_product") return null;
    throw error;
  }
});

const productForPage = cache(async (slug: string, marketId: MarketId, locale: string) => {
  const product = await catalog.getProduct(slug, marketId);
  if (product && marketId === "bd" && devLiveBangladeshFeed() && isMerchantBdPreviewProduct(product)) {
    return { kind: "legacy", product: await merchantBdPreviewPageProduct(product, merchantFeedSettings(marketId)), data: null } as const;
  }
  const connected = await connectedForPage(slug, marketId, locale).catch(error => {
    if (product && error instanceof CatalogApiError && error.code === "product_variant_limit") return null;
    throw error;
  });
  if (product) return { kind: "legacy", data: connected, product: connected?.product.locale ? { ...product,
    name: connected.product.name, description: connected.product.description, shortDescription: connected.product.shortDescription ?? undefined,
  } : product } as const;
  return connected && { kind: "connected", data: connected } as const;
});

function pageProductMetadata(page: NonNullable<Awaited<ReturnType<typeof productForPage>>>, market: Market, address: string) {
  return page.kind === "connected" ? connectedProductMetadata(page.data.product, page.data.variants, address)
    : productMetadata(page.product, address, page.data?.variants,
      merchantProductUrl(address, page.product.slug, market.id, hybridDemoMode()));
}

const productPageAddress = cache(async (productId: string, slug: string, id: MarketId, locale: string) => {
  const market = { id, locale };
  const alternates = await productSeoAlternates({ id: productId, slug }, market);
  return { alternates, href: alternates?.canonical ?? catalogAbsoluteUrl(`/products/${encodeURIComponent(slug)}`, market) };
});

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [market, { slug }, query] = await Promise.all([currentMarket(), params, searchParams]);
  const page = await productForPage(slug, market.id, market.locale);
  if (!page) return { title: "Product not found", robots: { index: false, follow: true } };
  const product = page.kind === "legacy" ? page.product : page.data.product;
  const { alternates, href } = await productPageAddress(product.id, product.slug, market.id, market.locale);
  const { title, description, images, markup } = pageProductMetadata(page, market, href);
  const variants = markup ? "hasVariant" in markup ? markup.hasVariant : [markup] : [];
  const exact = validVariantId(query.variant) ? variants?.find(variant => new URL(variant.url).searchParams.get("variant") === query.variant) : undefined;
  return { title: exact?.name ?? title, description, alternates, robots: catalogRobots(market),
    openGraph: { title: exact?.name ?? title, description, images: exact?.image.length ? exact.image : images } };
}

async function productCategoryTrail(productId: string, requested: SearchParams["category"], market: Market) {
  if (typeof requested !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(requested)) return null;
  const data = await connectedCategoryDetail(requested, { marketId: market.id, locale: market.locale });
  if (!data || data.category.id !== requested) return null;
  const ids = [requested, ...data.descendantCategoryIds];
  const belongs = await getDb().product.findFirst({ where: { id: productId, OR: [
    { departmentId: { in: ids } }, { secondaryCategories: { some: { departmentId: { in: ids } } } },
  ] }, select: { id: true } });
  if (!belongs) return null;
  const context = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
  return { id: requested, crumbs: [...data.ancestors, data.category].map(category => ({
    label: category.shortName, href: catalogBrowseHref(`/departments/${encodeURIComponent(category.localizedSlug)}`, context),
  })) };
}

function ConnectedProductView({ data, market, variantId, requested, trail, query, invalidVariant = false, invalidOptions = false }: {
  data: ConnectedProduct; market: Market; variantId?: string; requested: Map<string, string>;
  trail: Awaited<ReturnType<typeof productCategoryTrail>>; query: SearchParams; invalidVariant?: boolean; invalidOptions?: boolean;
}) {
  const { product, variants, defaultVariantId, primaryBreadcrumb } = data;
  const contextual = !invalidOptions && !variantId && requested.size > 0;
  const choices = contextual ? variants.filter(variant => matchesBrowseProductSelection(variant.options, requested)) : variants;
  const initialId = variantId ?? (contextual ? choices.length === 1 ? choices[0].id : undefined : defaultVariantId);
  const selected = invalidVariant || invalidOptions ? undefined : choices.find(variant => variant.id === initialId);
  const unavailable = invalidVariant || Boolean(variantId && !selected || contextual && !choices.length);
  const context = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
  const crumbs = trail?.crumbs ?? primaryCrumbs(primaryBreadcrumb, market);
  const href = catalogAbsoluteUrl(`/products/${encodeURIComponent(product.slug)}`, market);
  const known = contextual ? choices[0]?.options.filter(option => choices.every(variant =>
    variant.options.some(item => item.key === option.key && item.value === option.value))) : undefined;
  return <div className="shell inner-page">
    <CatalogJsonLd data={breadcrumbMetadata(crumbs, { label: product.name, href })} />
    <Breadcrumbs items={[...crumbs, { label: product.name }]} />
    <div className="product-detail connected-product-detail">
      <ConnectedProductGallery key={selected?.id ?? "parent"} sharedImages={product.images} variant={selected} />
      <div className="product-detail__info">
        <h1 className="display-type">{product.name}</h1>
        {selected?.offer.eligible && <p className="product-detail__price">{formatMoney(selected.offer.amountMinor, market)}</p>}
        <p className="product-detail__description">{product.description}</p>
        {!!known?.length && <p className="product-detail__note">Matching options {known.map(option => option.valueLabel).join(" · ")}</p>}
        {invalidOptions ? <p role="status">The options in this link don’t match a variant here. Choose from the available options.</p>
          : unavailable && <p role="status">{invalidVariant ? "This link contains an invalid variant." :
            variantId ? `This variant is unavailable in ${market.name}.` : `These options are unavailable in ${market.name}.`}</p>}
        <ul className="mp-subcategory-links" aria-label="Product options">
          {(choices.length ? choices : variants).map((variant, index) => <li key={variant.id}>
            <Link href={catalogProductHref({ slug: product.slug, matchedVariantId: variant.id, knownOptions: [] }, context, trail?.id)}
              aria-current={selected?.id === variant.id ? "page" : undefined}>
              {variant.options.map(option => option.valueLabel).join(" / ") || variant.label || `Option ${index + 1}`}
            </Link>
          </li>)}
        </ul>
        <p className="product-detail__note">Choose an exact variant to continue.</p>
        {variants.some(variant => variant.offer.eligible) && <CompareProduct slug={product.slug} name={product.name} market={context} />}
      </div>
    </div>
    <ConnectedDiscovery data={data} market={market} query={query} />
  </div>;
}

async function connectedDeliveryChoices(market: Awaited<ReturnType<typeof currentMarket>>, data: ConnectedProduct): Promise<ProductDeliveryChoice[]> {
  if (market.checkoutAuthority !== "native" || integratedCheckout(market.id) || !data.variants.some(variant => variant.offer.id && variant.offer.eligible)) return [];
  const [cod, prepaid] = await Promise.all([deliveryChoices(market.id), deliveryChoices(market.id, "SSLCOMMERZ")]);
  const paypal = paypalCheckoutAvailability(market.id).paymentEnabled;
  return [
    ...cod.map(choice => ({ ...choice, paymentMethod: "COD" as const })),
    ...prepaid.map(choice => ({ ...choice, paymentMethod: "SSLCOMMERZ" as const })),
    ...(paypal ? [...contiguousStates].map(state => ({ district: state.toLowerCase(), districtLabel: state,
      method: "sandbox-standard", label: "Standard delivery", paymentMethod: "PAYPAL" as const })) : []),
  ];
}

async function ConnectedPurchaseView({ data, variantId, market, trail, query, hasLegacyOffers }: {
  data: ConnectedProduct; variantId?: string; market: Awaited<ReturnType<typeof currentMarket>>;
  trail: Awaited<ReturnType<typeof productCategoryTrail>>; query: SearchParams; hasLegacyOffers?: boolean;
}) {
  const [choices, archived] = await Promise.all([
    connectedDeliveryChoices(market, data),
    validVariantId(variantId) && !data.variants.some(variant => variant.id === variantId) ? getDb().variant.findFirst({
      where: { id: variantId, productId: data.product.id, archivedAt: { not: null } }, select: { id: true },
    }) : null,
  ]);
  const crumbs = trail?.crumbs ?? primaryCrumbs(data.primaryBreadcrumb, market);
  const { href } = await productPageAddress(data.product.id, data.product.slug, market.id, market.locale);
  return <div className="shell inner-page">
    <CatalogJsonLd data={connectedProductMetadata(data.product, data.variants, href).markup} />
    <CatalogJsonLd data={breadcrumbMetadata(crumbs, { label: data.product.name, href })} />
    <Breadcrumbs items={[...crumbs, { label: data.product.name }]} />
    <ConnectedProductDetail key={`${market.id}:${market.locale}:${data.product.id}`} data={data} market={market} deliveryChoices={choices}
      postalRequired={market.address.adapter === "us-postal"} timeZone={market.timeZone} archivedVariantId={archived?.id}
      hasLegacyOffers={hasLegacyOffers} regional={hybridDemoMode()} />
    {data.variants.some(row => row.offer.id && row.offer.eligible) &&
      <WhatsAppHandoff subject="product" href={whatsAppProductInquiry(market.id, data.product.name, href)}/>}
    <ConnectedDiscovery data={data} market={market} query={query} />
  </div>;
}

export default async function ProductPage({ params, searchParams }: Props) {
  const [market, { slug }, query] = await Promise.all([currentMarket(), params, searchParams]);
  const page = await productForPage(slug, market.id, market.locale);
  if (!page) notFound();
  const variantId = typeof query.variant === "string" ? query.variant : undefined;
  const requested = browseProductSelection(query.option);
  const trail = await productCategoryTrail(page.kind === "connected" ? page.data.product.id : page.product.id, query.category, market);
  if (page.kind === "connected") {
    return <ConnectedPurchaseView data={page.data} {...{ market, variantId, trail, query }} />;
  }
  const { product } = page;
  let requestedLegacyVariant = variantId;
  if (query.variant !== undefined && !product.variants.some(variant => variant.id === variantId)) {
    const data = await connectedForPage(slug, market.id, market.locale);
    if (!data) notFound();
    if (data.variants.some(variant => variant.offer.id)) return <ConnectedPurchaseView data={data} {...{ market, variantId, trail, query }} hasLegacyOffers />;
    return <ConnectedProductView data={data} {...{ market, variantId, requested, trail, query }} invalidVariant={!validVariantId(variantId)} />;
  }
  if (query.variant === undefined && query.option !== undefined) {
    const data = await connectedForPage(slug, market.id, market.locale);
    if (!data) notFound();
    const submitted = new Set(Array.isArray(query.option) ? query.option : [query.option]);
    const invalidOptions = submitted.size !== requested.size;
    const matching = invalidOptions ? [] : data.variants.filter(variant => matchesBrowseProductSelection(variant.options, requested));
    if (matching.some(variant => variant.offer.id)) return <ConnectedPurchaseView data={data} {...{ market, trail, query }} hasLegacyOffers />;
    if (matching.length !== 1) return <ConnectedProductView data={data} {...{ market, requested, trail, invalidOptions, query }} />;
    requestedLegacyVariant = matching[0].id;
  }
  const departments = await catalog.listDepartments(market.id);
  const department = departments.find((item) => item.id === product.departmentId);
  const hybrid = hybridDemoMode();
  const db = getDb();
  const [related, sold, complementary, watches, marketDelivery, ranking] = await Promise.all([
    loadRecommendations({ marketId: market.id, locale: market.locale, placement: "similar", anchorProductId: product.id, limit: 4 })
      .catch(error => { reportFailure("recommendations.product-similar", undefined, error); return null; }),
    hybrid ? db.orderItem.aggregate({ where: { variant: { productId: product.id }, order: {
      marketId: market.id, status: "PLACED", measurementTest: false, payment: { status: { in: ["PAID", "COLLECTED"] } },
    } }, _sum: { quantity: true } }) : null,
    loadRecommendations({ marketId: market.id, locale: market.locale, placement: "complementary", anchorProductId: product.id, limit: 3 })
      .catch(error => { reportFailure("recommendations.product-complementary", undefined, error); return null; }),
    marketplaceMode() && product.shop ? getShopper().then(async shopper => ({ shopperId: shopper?.id,
      options: shopper ? await variantWatchSettings(shopper.id, market.id, product.variants.map(variant => variant.id)) : [],
    })) : undefined,
    marketHasDelivery(market.id),
    recommendationConfig(market.id, market.locale).catch(error => { reportFailure("recommendations.product-config", undefined, error); return null; }),
  ]);
  const initialVariantId = product.variants.find((variant) => variant.id === requestedLegacyVariant)?.id;
  const complementaryCards = productCards(complementary?.items.map(item => item.product) ?? []);
  const complements = new Set(complementaryCards.map(card => card.id));
  const relatedProducts = related?.items.map(item => item.product) ?? (marketDelivery
    ? eligibleHomeProducts(await catalog.listProducts({ marketId: market.id, departmentId: product.departmentId }), market) : []);
  const cards = productCards(relatedProducts.filter(item => item.id !== product.id && !complements.has(item.id))).slice(0, 4);
  const { href } = await productPageAddress(product.id, product.slug, market.id, market.locale);
  const { markup } = pageProductMetadata(page, market, href);
  const crumbs = trail?.crumbs ?? primaryCrumbs(page.data?.primaryBreadcrumb ?? (department ? [department] : []), market);
  const firstParty = firstPartyStoreMode();
  const models = firstParty || hybrid ? catalogDevices([product]) : [];
  const addOns: ProductAddOn[] = complementaryCards.filter(card => !complementary?.items
    .find(item => item.productId === card.id)?.product.personalization?.required)
    .map(card => ({ ...card, recommendationVersion: complementary?.version }));
  const context = { id: market.id, locale: market.locale, regional: hybrid };
  return (
    <div className="shell inner-page">
      <CatalogJsonLd data={markup} />
      <CatalogJsonLd data={breadcrumbMetadata(crumbs, { label: product.name, href })} />
      <Breadcrumbs items={[...crumbs, { label: product.name }]} />
      <ProductDetail key={`${market.id}:${product.id}:${initialVariantId ?? ""}`} product={product} market={market} initialVariantId={initialVariantId}
        departmentName={department?.shortName ?? "Catalog"} firstParty={firstParty} hybrid={hybrid}
        sales={sold?._sum.quantity ?? 0} addOns={addOns} models={models.map(({ id, name }) => ({ id, name }))} watches={watches} checkoutEnabled={Boolean(product.shop && marketDelivery)} />
      {product.variants.some(row => row.offer?.marketId === market.id) &&
        <WhatsAppHandoff subject="product" href={whatsAppProductInquiry(market.id, product.name, href)}/>}
      <RecentlyViewedProduct id={product.id} marketId={market.id} personalizationEnabled={ranking?.behavioralEnabled ?? false} />
      <CompareProduct slug={product.slug} name={product.name} market={context} />
      {ranking?.behavioralEnabled && ranking.placements.continue.enabled && <RecentlyViewedLink market={context} />}
      {marketplaceMode() && <>
        <ProductReviews product={product} market={market} query={query} />
        <ProductQuestion product={product} market={market} />
      </>}
      {cards.length > 0 && (
        <section className="home-section" aria-labelledby="related-heading">
          <SectionHeading id="related-heading" title={related?.items.some(item => item.reason === "similar-attributes") ? "Similar products" : "More to explore"}
            action={department && { href: catalogBrowseHref(`/departments/${department.slug}`, context), label: `Shop ${department.shortName}` }} />
          <ProductGrid cards={cards} market={market} placement={{ placement: "similar", recommendationVersion: related?.version }} />
        </section>
      )}
      {!hybrid && complementaryCards.length > 0 && <section className="home-section" aria-labelledby="complementary-heading">
        <SectionHeading id="complementary-heading" title="Complete your setup" />
        <ProductGrid cards={complementaryCards} market={market} placement={{ placement: "complementary", recommendationVersion: complementary?.version }} />
      </section>}
    </div>
  );
}

async function ConnectedDiscovery({ data, market, query }: { data: ConnectedProduct; market: Market; query: SearchParams }) {
  const { product } = data;
  const ranking = await recommendationConfig(market.id, market.locale).catch(error => {
    reportFailure("recommendations.product-config", undefined, error);
    return null;
  });
  return <>
    <RecentlyViewedProduct id={product.id} marketId={market.id} personalizationEnabled={ranking?.behavioralEnabled ?? false} />
    {ranking?.behavioralEnabled && ranking.placements.continue.enabled &&
      <RecentlyViewedLink market={{ id: market.id, locale: market.locale, regional: hybridDemoMode() }} />}
    {marketplaceMode() && <>
      <ProductReviews product={product} market={market} query={query} />
      <ProductQuestion product={product} market={market} />
    </>}
    {ranking && <ConnectedRelatedProducts product={product} market={market} ranking={ranking} />}
  </>;
}

async function connectedRecommendationCards(product: ConnectedProduct["product"], market: Market,
  ranking: Awaited<ReturnType<typeof recommendationConfig>>) {
  const { similar, complementary } = ranking.placements;
  if (!similar.enabled && !complementary.enabled) return null;
  const local = { marketId: market.id, locale: market.locale };
  const companion = complementary.enabled && complementary.strategy === "curated"
    ? [...new Set([...complementary.boosts, ...complementary.fallback])]
      .filter(id => id !== product.id && !complementary.excludes.includes(id)) : [];
  const configured = similar.enabled
    ? [...new Set([...similar.boosts, ...similar.fallback])].filter(id => id !== product.id && !similar.excludes.includes(id) && !companion.includes(id))
    : [];
  try {
    const category = similar.enabled && similar.strategy === "attributes"
      ? await getDb().product.findMany({ where: {
        id: { notIn: [product.id, ...configured, ...companion, ...similar.excludes] },
        OR: [{ departmentId: product.primaryCategoryId }, { secondaryCategories: { some: { departmentId: product.primaryCategoryId } } }],
        variants: { some: catalogVariantWhere(market.id, true) },
      }, orderBy: [{ position: "asc" }, { id: "asc" }], take: 5, select: { id: true } }) : [];
    const order = [...configured, ...category.map(row => row.id)];
    const ids = [...new Set([...order, ...companion])];
    if (!ids.length) return null;
    const catalog = await listConnectedCatalog(new URLSearchParams({ limit: String(Math.min(100, ids.length)) }), local, undefined, undefined, { productIds: ids });
    const eligible = new Map(catalog.items.filter(item => item.representative.offer.eligible).map(item => [item.id, item]));
    const from = (ids: string[], limit: number) => ids.flatMap(id => eligible.get(id) ?? []).slice(0, limit);
    return { related: from(order, 4), companions: from(companion, 3) };
  } catch (error) {
    reportFailure("recommendations.connected-related", undefined, error);
    return null;
  }
}

async function ConnectedRelatedProducts({ product, market, ranking }: {
  product: ConnectedProduct["product"]; market: Market; ranking: Awaited<ReturnType<typeof recommendationConfig>>;
}) {
  const matching = await connectedRecommendationCards(product, market, ranking);
  if (!matching) return null;
  const { related, companions } = matching;
  return <>
      {!!related.length && <section className="home-section" aria-labelledby="connected-related-heading">
        <SectionHeading id="connected-related-heading" title="Related products" />
        <ConnectedCatalogCards products={related} market={market} offset={0} placement="similar" />
      </section>}
      {!!companions.length && <section className="home-section" aria-labelledby="connected-companions-heading">
        <SectionHeading id="connected-companions-heading" title="Complete your setup" />
        <ConnectedCatalogCards products={companions} market={market} offset={0} placement="complementary" />
      </section>}
    </>;
}
