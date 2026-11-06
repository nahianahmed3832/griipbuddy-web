import { compareProducts, inCategory, relevance } from '@/features/catalog/browse';
import { categoryHref, flattenCategories, marketForSegment, productHref, validSlug, type Suggestion } from '@/features/catalog/catalog';
import { catalogNavigation, catalogProduct, catalogProducts, variantStock } from '@/features/catalog/data';

export const dynamic = 'force-dynamic';

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

export async function GET(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const query = new URL(request.url).searchParams;
  if (!['suggest', 'items', 'stock'].includes(action)) return json({ error: 'Unknown catalog route.' }, 404);

  try {
    const { markets, categories } = await catalogNavigation();
    const market = marketForSegment(markets, query.get('market')?.toLowerCase());
    if (!market) return json({ error: 'This market is unavailable.' }, 404);

    if (action === 'stock') {
      const product = await catalogProduct(market, query.get('product') ?? '');
      const variant = product?.variants.find((entry) => entry.id === query.get('variant') && entry.price);
      if (!product || !variant) return json({ error: 'This variant is unavailable.' }, 404);
      return json({ stock: await variantStock(product, variant) });
    }

    if (action === 'items') {
      const slugs = [...new Set(query.getAll('slug').filter(validSlug))].slice(0, 30);
      if (!slugs.length) return json({ products: [] });
      const products = new Map((await catalogProducts(market)).filter((product) => slugs.includes(product.slug)).map((product) => [product.slug, product]));
      return json({ products: slugs.flatMap((slug) => products.get(slug) ?? []) });
    }

    const text = (query.get('q') ?? '').trim().slice(0, 100);
    if (text.length < 2) return json({ suggestions: [] });
    const scope = categories.find((category) => category.slug === query.get('category'));
    const taxonomy = flattenCategories(scope ? [scope] : categories);
    const matches: Suggestion[] = taxonomy
      .filter((category) => category.label.toLowerCase().includes(text.toLowerCase()) || category.slug.includes(text.toLowerCase()))
      .slice(0, 2)
      .map((category) => ({ title: category.label, href: categoryHref(market, category.path), kind: 'Category' }));

    const products = (await catalogProducts(market, false, scope?.slug))
      .filter((product) => !scope || inCategory(product, scope.path))
      .map((product) => ({ product, score: relevance(product, text) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || compareProducts(a.product, b.product, 'newest'))
      .slice(0, 6)
      .map(({ product }): Suggestion => ({ title: product.name, href: productHref(market, product.slug), kind: 'Product' }));

    return json({ suggestions: [...products, ...matches].slice(0, 7) });
  } catch {
    return json({ error: 'The catalog is temporarily unavailable.' }, 503);
  }
}
