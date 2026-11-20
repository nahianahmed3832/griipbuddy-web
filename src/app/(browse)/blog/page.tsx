import { EditorialIndex } from "@/components/marketplace/editorial";
import { publishedEditorial } from "@/lib/catalog/editorial";
import { editorialSlug } from "@/lib/catalog/editorial-contract";
import { currentMarket } from "@/lib/market-server";

export const metadata = { title: "Blog" };

export default async function Blog({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [market, query] = await Promise.all([currentMarket(), searchParams]);
  const content = await publishedEditorial(market.id, market.locale);
  const category = editorialSlug.safeParse(query.category).data ?? "";
  const term = typeof query.q === "string" ? query.q.trim().slice(0, 100) : "";
  const requested = typeof query.page === "string" && /^\d{1,3}$/.test(query.page) ? Number(query.page) : 1;
  return <EditorialIndex market={market} content={content} term={term} category={category} page={Math.max(1, requested)} />;
}
