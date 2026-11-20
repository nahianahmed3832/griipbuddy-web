import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { marketIds, type MarketId } from "../../config/markets.ts";
import { getDb } from "../db/client.ts";
import { localMarketTime } from "../market-calendar.ts";
import { isMarketSelectable, marketConfiguration, marketIdInput } from "../market-config.ts";
import { catalogImage, textField } from "../staff/catalog-input.ts";
import { uploadLimit } from "../staff/catalog-media.ts";
import { requireMainAdminMediaStorage } from "../staff/catalog-media-upload.ts";
import { canEditHomepage, homepageEditorData, publishHomepage, restoreInheritedHomepage, saveHomepageDraft } from "../staff/homepage.ts";
import { homepageAllowedMedia, storeHomepageImage } from "../staff/homepage-media.ts";
import { catalogWriteInput, CatalogWriteError } from "../staff/operation-error.ts";
import { consumeQuota } from "../db/observability.ts";
import { listCategoryPresentation } from "./category-presentation.ts";
import { publicCollectionScope } from "./collection-selection.ts";
import { catalogVariantWhere } from "./connected-public.ts";
import { previewMarketMatches } from "./homepage-content.ts";
import {
  defaultHomepage, homepageInput, homepageLayers, homepageTileImages, mergeHomepage, parseHomepageScope, scopeKey, type HomepageContentData, type HomepageScope,
} from "./homepage-contract.ts";
import { editorialInput } from "./editorial-contract.ts";
import { editorialEditor, updateEditorial, type EditorialScope } from "../staff/editorial.ts";
import { homepageReadPayload } from "./homepage-layout.ts";
import { readMainAdminAsset } from "./main-admin-reads.ts";

const scopeInput = z.string().max(60);
export const mainAdminHomepageReads = [
  z.strictObject({ read: z.literal("homepage-scopes") }),
  z.strictObject({ read: z.literal("homepage-editorial"), homepageScope: scopeInput }),
  z.strictObject({ read: z.literal("homepage"), homepageScope: scopeInput }),
  z.strictObject({ read: z.literal("homepage-preview"), homepageScope: scopeInput, marketId: marketIdInput,
    locale: textField(1, 35), previewAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional() }),
  z.strictObject({ read: z.literal("homepage-references"), homepageScope: scopeInput,
    kind: z.enum(["products", "categories", "collections", "media"]), q: textField(0, 120).optional() }),
  z.strictObject({ read: z.literal("homepage-asset"), id: catalogImage.shape.src }),
] as const;
export const mainAdminHomepageReadInput = z.discriminatedUnion("read", mainAdminHomepageReads);
type Read = z.infer<typeof mainAdminHomepageReadInput>;

const homepageCommands = ["homepage.save", "homepage.publish", "homepage.restore", "homepage.inherit", "homepage.media",
  "homepage.editorial-save", "homepage.editorial-publish", "homepage.editorial-withdraw"] as const;
type Command = typeof homepageCommands[number];
export function isHomepageCommand(action: string): action is Command {
  return homepageCommands.some(command => command === action);
}

const maxImageEncoded = Math.ceil(uploadLimit / 3) * 4;
const revisionInput = z.strictObject({ homepageScope: scopeInput, expectedRevision: z.int().min(0) });
const saveInput = revisionInput.extend({ content: homepageInput });
const editorialSaveInput = revisionInput.extend({ content: editorialInput });
const restoreInput = revisionInput.extend({ releaseId: z.uuid() });
const uploadInput = z.strictObject({ homepageScope: scopeInput, data: z.string().min(4).max(maxImageEncoded),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]) });

type Actor = { id: string; owner: boolean; marketId: MarketId };

async function allowedScope(actor: Actor, key: string) {
  const scope = parseHomepageScope(key);
  if (!scope) throw new CatalogWriteError("invalid_input", "Choose a valid homepage market and language.");
  if ((scope.marketId ? scope.marketId !== actor.marketId : !actor.owner) || !await canEditHomepage(actor.id, scope)) {
    throw new CatalogWriteError("forbidden", "This homepage scope is unavailable for your selected region.");
  }
  return scope;
}

async function allowedEditorialScope(actor: Actor, key: string): Promise<EditorialScope> {
  const scope = await allowedScope(actor, key);
  if (!scope.marketId || !scope.locale) throw new CatalogWriteError("invalid_input", "Choose one market and language for editorial content.");
  return { marketId: scope.marketId, locale: scope.locale };
}

function selectablePreviews(scope: HomepageScope) {
  return marketIds.filter(isMarketSelectable).filter(id => !scope.marketId || scope.marketId === id).flatMap(id => {
    const market = marketConfiguration(id);
    if (scope.locale && !market.languages.includes(scope.locale)) return [];
    return [{ marketId: id, label: market.name, locales: scope.locale ? [scope.locale] : market.languages,
      defaultLocale: scope.locale ?? market.defaultLocale, timeZone: market.timeZone, currency: market.currency }];
  });
}

function homepageScopes(actor: Actor) {
  const market = marketConfiguration(actor.marketId);
  const choices = [{ scope: { marketId: market.id }, label: `${market.name} · all languages` }, ...market.languages.map(locale => ({
    scope: { marketId: market.id, locale }, label: `${market.name} · ${locale}`,
  }))];
  const languages = new Set(marketIds.filter(isMarketSelectable).flatMap(id => marketConfiguration(id).languages));
  const scopes = actor.owner ? [{ scope: {}, label: "Global · all languages" },
    ...[...languages].map(locale => ({ scope: { locale }, label: `Global · ${locale}` })), ...choices] : choices;
  return { scopes: scopes.map(({ scope, label }) => ({ key: scopeKey(scope), label, previews: selectablePreviews(scope) })) };
}

type Reference = { id: string; label: string; image?: { src: string; alt: string }; href?: string };
const searchLimit = 24;
const byLabel = (q: string) => ({ contains: q, mode: "insensitive" as const });
const referenceHref = (group: "departments" | "collections" | "products", slug: string) =>
  /^[a-z0-9-]+$/.test(slug) ? `/${group}/${slug}` : undefined;

async function references(scope: HomepageScope, kind: Extract<Read, { read: "homepage-references" }>["kind"], q = "", ids?: string[]) {
  if (ids && !ids.length) return { items: [] };
  const db = getDb();
  const previews = selectablePreviews(scope);
  const term = q.trim();
  const matches = (id: string, label: string) => !term || [id, label].some(value => value.toLowerCase().includes(term.toLowerCase()));
  const items = new Map<string, Reference>();
  const add = (id: string, label: string, image?: Reference["image"], href?: string) => {
    if ((!ids || ids.includes(id)) && !items.has(id) && matches(id, label)) items.set(id, { id, label, image, href });
  };

  if (kind === "products" || kind === "media") {
    const rows = await db.product.findMany({ where: { active: true, publication: "ACTIVE", ...(ids && { id: { in: ids } }),
      AND: [{ OR: previews.map(({ marketId }) => ({ variants: { some: catalogVariantWhere(marketId) } })) },
        ...(term ? [{ OR: [{ id: byLabel(term) }, { name: byLabel(term) }, { slug: byLabel(term) },
          { translations: { some: { name: byLabel(term) } } }, { variants: { some: { sku: byLabel(term) } } },
          ...(kind === "media" ? [{ images: { some: { OR: [{ src: byLabel(term) }, { alt: byLabel(term) }] } } }] : []),
        ] }] : [])] },
      take: ids?.length ?? searchLimit, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, slug: true, name: true, images: {
        orderBy: [{ isPrimary: "desc" }, { position: "asc" }], take: 3, select: { src: true, alt: true },
      } } });
    for (const row of rows) {
      if (kind === "products") items.set(row.id, { id: row.id, label: row.name, image: row.images[0], href: referenceHref("products", row.slug) });
      else for (const image of row.images) add(image.src, image.alt, image);
    }
  }
  if (kind === "categories" || kind === "media") {
    const catalogs = await Promise.all(previews.map(({ marketId, defaultLocale }) => listCategoryPresentation(marketId, defaultLocale, db)));
    for (const categories of catalogs) for (const category of categories) {
      if (kind === "categories") add(category.id, category.name, category.image, referenceHref("departments", category.slug));
      else for (const image of [category.image, category.banner]) if (image) add(image.src, image.alt, image);
    }
  }
  if (kind === "collections" || kind === "media") {
    const rows = await db.collection.findMany({ where: { ...(ids && { id: { in: ids } }), AND: [{ OR: previews.map(({ marketId }) => publicCollectionScope(marketId)) },
      ...(term ? [{ OR: [{ id: byLabel(term) }, { name: byLabel(term) }, { slug: byLabel(term) }, ...(kind === "media" ?
        [{ imageSrc: byLabel(term) }, { imageAlt: byLabel(term) }] : [])] }] : [])] }, take: ids?.length ?? searchLimit,
      orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, slug: true, name: true, imageSrc: true, imageAlt: true } });
    for (const row of rows) {
      const image = row.imageSrc && row.imageAlt ? { src: row.imageSrc, alt: row.imageAlt } : undefined;
      if (kind === "collections") items.set(row.id, { id: row.id, label: row.name, image, href: referenceHref("collections", row.slug) });
      else if (image) add(image.src, image.alt, image);
    }
  }
  if (kind === "media") {
    const existing = await db.auditEvent.findMany({ where: { action: "MERCHANDISING_REVIEW", target: {
      startsWith: "homepage-media:", ...(term && { contains: term, mode: "insensitive" }),
    }, AND: [{ changes: { path: ["step"], equals: "homepage-image-uploaded" } }, ...(scope.marketId ?
      [{ changes: { path: ["marketId"], equals: scope.marketId } }] : [])] }, orderBy: { createdAt: "desc" },
      distinct: ["target"], take: searchLimit, select: { target: true } });
    for (const { target } of existing) {
      const src = target.replace(/^homepage-media:/, "/media/");
      add(src, `Homepage upload · ${src.slice(7, 15)}`, { src, alt: "" });
    }
    const approved = await homepageAllowedMedia(db, scope, [...items.keys()]);
    return { items: [...items.values()].filter(item => approved.has(item.id)).slice(0, searchLimit) };
  }
  return { items: [...items.values()].slice(0, ids?.length ?? searchLimit) };
}

function draftContent(raw: unknown, key: string): HomepageContentData {
  return homepageInput.safeParse(raw).data ?? (key === "global:default" ? defaultHomepage : { sections: [], hiddenSections: [] });
}

function protectedHero(content: HomepageContentData) {
  return { section: content.sections.find(section => section.key === "hero"), hidden: content.hiddenSections.includes("hero") };
}

export async function readMainAdminHomepage(actor: Actor, request: Read) {
  if (request.read === "homepage-scopes") return homepageScopes(actor);
  if (request.read === "homepage-editorial") return editorialEditor(actor.id, await allowedEditorialScope(actor, request.homepageScope));

  if (request.read === "homepage-asset") {
    const permitted = await homepageAllowedMedia(getDb(), actor.owner ? {} : { marketId: actor.marketId }, [request.id]);
    if (!permitted.has(request.id)) throw new CatalogWriteError("not_found", "This homepage image is unavailable.");
    return readMainAdminAsset(request.id);
  }
  const scope = await allowedScope(actor, request.homepageScope);
  if (request.read === "homepage-references") return references(scope, request.kind, request.q);
  if (request.read === "homepage-preview") {
    const market = marketConfiguration(request.marketId);
    if (!isMarketSelectable(market.id) || !market.languages.includes(request.locale) || !previewMarketMatches(scope, market.id, request.locale)) {
      throw new CatalogWriteError("invalid_input", "Choose a market and language available to this preview.");
    }
    const at = request.previewAt ? localMarketTime(request.previewAt, market.timeZone) : undefined;
    if (request.previewAt && !at) throw new CatalogWriteError("invalid_input", "Choose an unambiguous local date and time.");
    return homepageReadPayload({ ...market, locale: request.locale }, { previewScopeKey: scopeKey(scope), at: at ?? undefined });
  }
  const row = await homepageEditorData(actor.id, scope);
  const preview = selectablePreviews(scope).find(market => market.marketId === actor.marketId) ?? selectablePreviews(scope)[0];
  const keys = preview ? homepageLayers(preview.marketId, preview.defaultLocale).map(scopeKey) : [];
  const ancestors = keys.slice(0, Math.max(0, keys.indexOf(request.homepageScope)));
  const previous = ancestors.length ? await getDb().homepageContent.findMany({ where: { key: { in: ancestors } },
    select: { key: true, published: { select: { content: true } } } }) : [];
  const inherited = mergeHomepage([defaultHomepage, ...ancestors.flatMap(key =>
    homepageInput.safeParse(previous.find(entry => entry.key === key)?.published?.content).data ?? [])]);
  const history = row?.history ?? [];
  const draft = draftContent(row?.draft, request.homepageScope);
  const sections = [...draft.sections, ...inherited];
  const selected = (ids: string[]) => [...new Set(ids)];
  const tiles = sections.flatMap(section => section.tiles ?? []);
  const tileIds = (kind: typeof tiles[number]["kind"]) => tiles.filter(tile => tile.kind === kind).map(tile => tile.referenceId);
  const [authors, products, categories, collections] = await Promise.all([
    history.length ? getDb().user.findMany({ where: { id: { in: selected(history.map(item => item.actorId)) } }, select: { id: true, name: true } }) : [],
    references(scope, "products", "", selected([...tileIds("PRODUCT"), ...sections.flatMap(section => [...section.productIds ?? [], ...section.fallbackIds ?? []])])),
    references(scope, "categories", "", selected([...tileIds("CATEGORY"), ...sections.flatMap(section => [...section.categoryIds ?? [], ...section.categoryId ? [section.categoryId] : []])])),
    references(scope, "collections", "", selected([...tileIds("COLLECTION"), ...sections.flatMap(section => section.collectionIds ?? [])])),
  ]);
  const media = new Map(sections.flatMap(section => section.type === "TILES" ? homepageTileImages(section) : section.bannerImage ? [section.bannerImage] : [])
    .map(image => [image.src, image]));
  return { revision: row?.revision ?? 0, draft, hasDraft: Boolean(row),
    publishedId: row?.publishedId ?? null, history: history.map(({ id, publishedAt, restoredFrom, actorId }) => ({ id, publishedAt, restoredFrom,
      actorName: authors.find(author => author.id === actorId)?.name ?? null })),
    inheritedSections: inherited.map(section => ({ key: section.key, title: section.title, type: section.type, position: section.position, section })),
    references: { products: products.items, categories: categories.items, collections: collections.items,
      media: [...media.values()].map(image => ({ id: image.src, label: image.alt || image.src, image })) },
  };
}

export async function runMainAdminHomepage(actor: Actor, action: Command, raw: unknown) {
  if (action === "homepage.editorial-save") {
    const input = catalogWriteInput(editorialSaveInput, raw);
    return updateEditorial(actor.id, await allowedEditorialScope(actor, input.homepageScope), input.expectedRevision, "save", input.content);
  }
  if (action === "homepage.editorial-publish" || action === "homepage.editorial-withdraw") {
    const input = catalogWriteInput(revisionInput, raw);
    const command = action === "homepage.editorial-publish" ? "publish" : "withdraw";
    return updateEditorial(actor.id, await allowedEditorialScope(actor, input.homepageScope), input.expectedRevision, command);
  }
  if (action === "homepage.media") {
    const { homepageScope, data, contentType } = catalogWriteInput(uploadInput, raw);
    const scope = await allowedScope(actor, homepageScope);
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > uploadLimit || bytes.toString("base64") !== data) throw new CatalogWriteError("invalid_input", "Supply a valid image up to 4 MB.");
    await requireMainAdminMediaStorage();
    if (!await consumeQuota("image.upload", actor.id, 50, 600)) throw new CatalogWriteError("rate_limited", "Too many image uploads.");
    return storeHomepageImage(actor.id, scope, bytes, contentType);
  }
  const draftInput = action === "homepage.save" ? catalogWriteInput(saveInput, raw) : undefined;
  const restore = action === "homepage.restore" ? catalogWriteInput(restoreInput, raw) : undefined;
  const input = draftInput ?? restore ?? catalogWriteInput(revisionInput, raw);
  const scope = await allowedScope(actor, input.homepageScope);
  const db = getDb();
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${input.homepageScope}), 42)`;
    const row = await tx.homepageContent.findUnique({ where: { key: input.homepageScope }, select: {
      draft: true, revision: true, published: { select: { content: true } },
    } });
    if (input.expectedRevision !== (row?.revision ?? 0)) throw new CatalogWriteError("conflict", "The homepage changed. Reload and try again.");
    const draft = draftContent(row?.draft, input.homepageScope);
    const published = draftContent(row?.published?.content, input.homepageScope);
    if (draftInput) {
      if (!isDeepStrictEqual(protectedHero(draft), protectedHero(draftInput.content))) {
        throw new CatalogWriteError("invalid_input", "Edit the top hero in its existing Homepage controls.");
      }
      return saveHomepageDraft(actor.id, scope, input.expectedRevision, draftInput.content, tx, { editor: "main-admin" });
    }
    if (action === "homepage.inherit") {
      if (!isDeepStrictEqual(protectedHero(published), protectedHero(draftContent(null, input.homepageScope)))) {
        throw new CatalogWriteError("conflict", "This scope also controls the top hero. Preserve its hero settings while updating the draft.");
      }
      return restoreInheritedHomepage(actor.id, scope, input.expectedRevision, tx);
    }
    const releaseId = restore?.releaseId;
    const release = releaseId ? await tx.homepageRelease.findFirst({ where: { id: releaseId, scopeKey: input.homepageScope },
      select: { content: true } }) : null;
    if (releaseId && !release) throw new CatalogWriteError("not_found", "That release does not belong to this homepage scope.");
    const candidate = releaseId ? draftContent(release?.content, input.homepageScope) : draft;
    if (!isDeepStrictEqual(protectedHero(published), protectedHero(candidate))) {
      throw new CatalogWriteError("conflict", "This release would change the top hero. Preserve its hero settings before publishing.");
    }
    return publishHomepage(actor.id, scope, input.expectedRevision, releaseId, tx, { editor: "main-admin" });
  });
}
