import { z } from "zod";

export const editorialSlug = z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(70);
const editorialImage = z.strictObject({
  src: z.string().regex(/^\/(?:editorial\/[a-z0-9-]+\.webp|catalog\/[a-z0-9-]+\.webp|media\/[a-f0-9]{64})$/),
  alt: z.string().trim().min(2).max(130),
});
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const category = z.strictObject({ slug: editorialSlug, label: z.string().trim().min(2).max(70) });
const document = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["ARTICLE", "PAGE"]),
  slug: editorialSlug,
  title: z.string().trim().min(2).max(100),
  summary: z.string().trim().min(2).max(220),
  body: z.array(z.string().trim().min(2).max(850)).min(1).max(8),
  category: editorialSlug.optional(),
  image: editorialImage.optional(),
  seoTitle: z.string().trim().min(2).max(70).optional(),
  seoDescription: z.string().trim().min(2).max(160).optional(),
  startsLocal: localTime.optional(),
  endsLocal: localTime.optional(),
}).superRefine((item, ctx) => {
  if (item.kind === "PAGE" && item.category) {
    ctx.addIssue({ code: "custom", path: ["category"], message: "Use a category on blog articles only." });
  }
  if (item.startsLocal && item.endsLocal && item.startsLocal >= item.endsLocal) {
    ctx.addIssue({ code: "custom", path: ["endsLocal"], message: "The end time must follow the start." });
  }
});

export const editorialInput = z.strictObject({
  documents: z.array(document).max(16),
  categories: z.array(category).max(16),
}).superRefine((content, ctx) => {
  const categories = new Set(content.categories.map(item => item.slug));
  if (categories.size !== content.categories.length) {
    ctx.addIssue({ code: "custom", path: ["categories"], message: "Use unique category slugs." });
  }
  const ids = new Set(content.documents.map(item => item.id));
  const urls = new Set(content.documents.map(item => item.kind + ":" + item.slug));
  if (ids.size !== content.documents.length || urls.size !== content.documents.length) {
    ctx.addIssue({ code: "custom", path: ["documents"], message: "Use each page and article slug once." });
  }
  const missing = content.documents.findIndex(item => item.category && !categories.has(item.category));
  if (missing >= 0) {
    ctx.addIssue({ code: "custom", path: ["documents", missing, "category"], message: "Choose a category from this draft." });
  }
});

export type EditorialContent = z.infer<typeof editorialInput>;
export type EditorialDocument = EditorialContent["documents"][number];
export const emptyEditorial: EditorialContent = { documents: [], categories: [] };
export const editorialKey = (marketId: string, locale: string) => `editorial:${marketId}:${locale}`;
