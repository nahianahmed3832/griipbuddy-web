import { categoryAt, type CatalogProduct, type Category, type Market } from './catalog';
import { compareProducts, inCategory } from './browse';
import { catalogProducts, variantStock, withAvailability } from './data';
import { Breadcrumbs, CatalogGrid } from './listing';
import { ProductExperience } from './product-experience';
import { RecentlyViewed } from './saved-products';

export async function ProductPage({ product, market, categories, requestedVariant }: {
  product: CatalogProduct; market: Market; categories: Category[]; requestedVariant?: string;
}) {
  const initial = product.variants.find((variant) => variant.id === requestedVariant)
    ?? product.variants.find((variant) => variant.price) ?? product.variants[0];
  const [stock, others] = await Promise.all([
    initial ? variantStock(product, initial) : null,
    catalogProducts(market).catch(() => []),
  ]);
  const candidates = others.filter((other) => other.id !== product.id);
  const related = candidates.filter((other) => product.category.length && inCategory(other, product.category.slice(0, 1)))
    .sort((a, b) => Number(inCategory(b, product.category)) - Number(inCategory(a, product.category)) || compareProducts(a, b, 'popular'))
    .slice(0, 4);
  const recommendations = candidates.filter((other) => !related.some((item) => item.id === other.id))
    .sort((a, b) => compareProducts(a, b, 'popular'))
    .slice(0, 4);
  const shelves = await withAvailability([...related, ...recommendations]);
  const category = categoryAt(categories, product.category);
  return (
    <div className="container catalog-page product-page">
      <Breadcrumbs market={market} categories={categories} path={category?.path ?? []} current={product.name} />
      <ProductExperience key={market.code + ':' + product.id + ':' + (initial?.id ?? '')}
        product={product} market={market} initialId={initial?.id} initialStock={stock} />
      {related.length > 0 && <section className="product-shelf" aria-label="Related products">
        <h2>Related products</h2><CatalogGrid products={shelves.slice(0, related.length)} market={market} />
      </section>}
      {recommendations.length > 0 && <section className="product-shelf" aria-label="You may also like">
        <h2>You may also like</h2><CatalogGrid products={shelves.slice(related.length)} market={market} />
      </section>}
      <RecentlyViewed market={market} slug={product.slug} />
    </div>
  );
}
