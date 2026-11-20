import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "../../generated/prisma/client.ts";
import { marketIds, markets, type MarketId } from "../../config/markets.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { marketConfiguration } from "../market-config.ts";
import { localMarketTime } from "../market-calendar.ts";
import { defaultHomepage, homepageInput, homepageTileImages, scopeKey, type HomepageContentData, type HomepageScope } from "../catalog/homepage-contract.ts";
import { resolveCategorySlug } from "../catalog/category-presentation.ts";
import { publicCollectionScope } from "../catalog/collection-selection.ts";
import { recommendationPolicyInput, type RecommendationPolicyOverride } from "../catalog/recommendation-policy.ts";
import { canUseMarket } from "./market-access.ts";
import { homepageAllowedMedia } from "./homepage-media.ts";
import { OperationError } from "./operations.ts";

export function validHomepageScope(scope: HomepageScope) {
  const applicable = (scope.marketId ? [scope.marketId] : marketIds).map(marketConfiguration);
  return applicable.some(market => !scope.locale || market.languages.includes(scope.locale));
}

export async function canEditHomepage(actorId: string, scope: HomepageScope, db: DbReader = getDb()) {
  if (!validHomepageScope(scope)) return false;
  if (scope.marketId) return canUseMarket(actorId, scope.marketId, "merchandising", db);
  const actor = await db.staffAccess.findUnique({ where: { userId: actorId }, select: { active: true, role: true } });
  return Boolean(actor?.active && actor.role === "OWNER");
}

async function requireHomepageScope(actorId: string, scope: HomepageScope, db: DbReader) {
  if (!await canEditHomepage(actorId, scope, db)) throw new OperationError("You don’t have permission for this homepage scope.");
}

function validateSchedule(scope: HomepageScope, content: HomepageContentData) {
  const applicable = (scope.marketId ? [scope.marketId] : marketIds).map(marketConfiguration)
    .filter(market => !scope.locale || market.languages.includes(scope.locale));
  for (const section of content.sections) {
    if (applicable.some(market => [section.startsLocal, section.endsLocal].some(value =>
      value && !localMarketTime(value, market.timeZone)))) {
      throw new OperationError(`The schedule for “${section.title}” uses a clock time that is skipped or repeated in a targeted market.`);
    }
  }
}

async function validateHomepageReferences(db: DbReader, scope: HomepageScope, content: HomepageContentData,
  previous: HomepageContentData | null, publishing = false) {
  const before = new Map(previous?.sections.map(section => [section.key, section]));
  const products = new Set<string>(), categories = new Set<string>(), collections = new Set<string>();
  const productSlugs = new Set<string>(), categorySlugs = new Set<string>(), collectionSlugs = new Set<string>();
  const media = new Set<string>();
  const add = (target: Set<string>, values: readonly string[] = [], previousValues: readonly string[] = []) => {
    if (new Set(values).size !== values.length && !isDeepStrictEqual(values, previousValues)) {
      throw new OperationError("Use each catalog reference once in a section.");
    }
    for (const value of values) if (!previousValues.includes(value)) target.add(value);
  };
  for (const section of content.sections) {
    const prior = before.get(section.key);
    if (section.budget && (!scope.marketId || section.budget.currency !== markets[scope.marketId].currency)) {
      throw new OperationError("Configure a budget in the selected market’s currency on a market template.");
    }
    add(products, section.productIds, prior?.productIds);
    add(products, section.fallbackIds, prior?.fallbackIds);
    add(categories, section.categoryIds, prior?.categoryIds);
    add(collections, section.collectionIds, prior?.collectionIds);
    if (section.categoryId && section.categoryId !== prior?.categoryId) categories.add(section.categoryId);
    if (section.collection && section.collection !== prior?.collection) collectionSlugs.add(section.collection);
    if (section.bannerImage && !isDeepStrictEqual(section.bannerImage, prior?.bannerImage)) {
      if (!section.bannerImage.alt) throw new OperationError("Describe the section image for shoppers who use assistive technology.");
      if (section.bannerImage.src !== prior?.bannerImage?.src) media.add(section.bannerImage.src);
    }
    const priorTiles = new Map(prior?.tiles?.map(tile => [tile.key, tile]));
    for (const tile of section.tiles ?? []) {
      const earlier = priorTiles.get(tile.key);
      const targets = tile.kind === "CATEGORY" ? categories : tile.kind === "COLLECTION" ? collections : products;
      if (tile.kind !== earlier?.kind || tile.referenceId !== earlier.referenceId) targets.add(tile.referenceId);
    }
    const priorMedia = new Set(prior && homepageTileImages(prior).map(image => image.src));
    for (const image of homepageTileImages(section)) if (!priorMedia.has(image.src)) media.add(image.src);
    if (section.link && section.link.href !== prior?.link?.href) {
      const [, group, slug] = section.link.href.split("/");
      if (group === "products") productSlugs.add(slug);
      if (group === "departments") categorySlugs.add(slug);
      if (group === "collections") collectionSlugs.add(slug);
    }
  }
  const applicable = (scope.marketId ? [scope.marketId] : marketIds).map(marketConfiguration)
    .filter(market => !scope.locale || market.languages.includes(scope.locale));
  const [foundProducts, foundCategories, foundCollections, localized, approved] = await Promise.all([
    products.size || productSlugs.size ? db.product.findMany({
      where: { OR: [{ id: { in: [...products] } }, { slug: { in: [...productSlugs] } }],
        ...(publishing ? { active: true, publication: "ACTIVE" } : { publication: { not: "ARCHIVED" } }) },
      select: { id: true, slug: true },
    }) : [],
    categories.size ? db.department.findMany({ where: { id: { in: [...categories] },
      state: publishing ? "ACTIVE" : { not: "ARCHIVED" } }, select: { id: true } }) : [],
    collections.size || collectionSlugs.size ? db.collection.findMany({
      where: { OR: [{ id: { in: [...collections] } }, { slug: { in: [...collectionSlugs] } }],
        ...(publishing && { AND: [{ OR: applicable.map(({ id }) => publicCollectionScope(id)) }] }) },
      select: { id: true, slug: true },
    }) : [],
    Promise.all([...categorySlugs].map(async slug =>
      (await Promise.all(applicable.map(market => resolveCategorySlug(slug, market.id, scope.locale ?? market.defaultLocale, db))))
        .some(Boolean))),
    media.size ? homepageAllowedMedia(db, scope, [...media]) : new Set<string>(),
  ]);
  const absent = (requested: Set<string>, actual: string[]) => [...requested].find(value => !actual.includes(value));
  if (absent(products, foundProducts.map(row => row.id)) || absent(productSlugs, foundProducts.map(row => row.slug))) {
    throw new OperationError("Choose a current catalog product. Publish any new product before publishing the homepage.");
  }
  if (absent(categories, foundCategories.map(row => row.id)) || localized.some(found => !found)) {
    throw new OperationError("Choose a current catalog category. Publish any new category before publishing the homepage.");
  }
  if (absent(collections, foundCollections.map(row => row.id)) || absent(collectionSlugs, foundCollections.map(row => row.slug))) {
    throw new OperationError("Choose a valid collection from the catalog.");
  }
  if ([...media].some(source => !approved.has(source))) throw new OperationError("Choose an approved image for this homepage scope.");
}

export async function homepageEditorData(actorId: string, scope: HomepageScope) {
  const db = getDb();
  await requireHomepageScope(actorId, scope, db);
  return db.homepageContent.findUnique({
    where: { key: scopeKey(scope) },
    include: { history: { orderBy: [{ publishedAt: "desc" }, { id: "desc" }], take: 30 } },
  });
}

function withHomepageTransaction<T>(tx: Prisma.TransactionClient | undefined, operation: (db: Prisma.TransactionClient) => Promise<T>) {
  return tx ? operation(tx) : getDb().$transaction(operation);
}

async function updateHomepageDraft(actorId: string, scope: HomepageScope, expectedRevision: number,
  update: (current: HomepageContentData | null) => HomepageContentData, tx?: Prisma.TransactionClient) {
  const key = scopeKey(scope);
  return withHomepageTransaction(tx, async tx => {
    await requireHomepageScope(actorId, scope, tx);
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${key}), 42)`;
    const row = await tx.homepageContent.findUnique({ where: { key }, select: { revision: true, draft: true } });
    if ((row?.revision ?? 0) !== expectedRevision) throw new OperationError("The homepage changed. Reload the editor and try again.");
    const previous = homepageInput.safeParse(row?.draft);
    const current = previous.success ? previous.data : null;
    const draft = update(current);
    validateSchedule(scope, draft);
    const baseline = current ?? (key === "global:default" ? defaultHomepage : null);
    await validateHomepageReferences(tx, scope, draft, baseline);
    const { revision } = await tx.homepageContent.upsert({
      where: { key },
      create: { key, marketId: scope.marketId, locale: scope.locale, draft },
      update: { draft, revision: { increment: 1 } },
      select: { revision: true },
    });
    await auditHomepageSections(tx, actorId, key, "homepage-draft-saved", baseline, draft, { revision });
    await auditRecommendationPolicy(tx, actorId, key, "recommendation-draft-saved", current?.recommendations, draft.recommendations, { revision });
    return { key, revision };
  });
}

async function auditHomepageSections(db: DbReader, actorId: string, key: string, step: string,
  before: HomepageContentData | null, after: HomepageContentData, change: { revision: number; releaseId?: string; restoredFrom?: string }) {
  const layout = (value: HomepageContentData | null) => value && { sections: value.sections, hiddenSections: value.hiddenSections };
  const previous = layout(before), next = layout(after);
  if (!change.releaseId && isDeepStrictEqual(previous, next)) return;
  await db.auditEvent.create({ data: { action: "MERCHANDISING_REVIEW", actorId, target: key,
    changes: { step, ...change, before: previous, after: next } } });
}

async function auditRecommendationPolicy(db: DbReader, actorId: string, key: string, step: string,
  before: RecommendationPolicyOverride | undefined, after: RecommendationPolicyOverride | undefined,
  release: { revision: number; releaseId?: string; restoredFrom?: string }) {
  if (isDeepStrictEqual(before, after)) return;
  await db.auditEvent.create({
    data: { action: "MERCHANDISING_REVIEW", actorId, target: key,
      changes: { step, ...release, before: before ?? null, after: after ?? null } },
  });
}

type HomepageEditorOptions = { editor?: "main-admin" };

function assertMainAdminSections(previous: HomepageContentData | null, next: HomepageContentData, options?: HomepageEditorOptions) {
  const sections = (content: HomepageContentData | null) =>
    content?.sections.filter(section => section.type === "TILES" || section.type === "BENEFITS") ?? [];
  if (options?.editor !== "main-admin" && !isDeepStrictEqual(sections(previous), sections(next))) {
    throw new OperationError("Manage merchandising and service tiles from the main GriipBuddy admin.");
  }
}

export async function saveHomepageDraft(actorId: string, scope: HomepageScope, expectedRevision: number, raw: unknown,
  tx?: Prisma.TransactionClient, options?: HomepageEditorOptions) {
  const parsed = homepageInput.safeParse(raw);
  if (!parsed.success) {
    const problem = parsed.error.issues[0];
    throw new OperationError(`${problem.path.join(".")} · ${problem.message}`);
  }
  return updateHomepageDraft(actorId, scope, expectedRevision, current => {
    assertMainAdminSections(current, parsed.data, options);
    return { ...parsed.data, recommendations: parsed.data.recommendations ?? current?.recommendations };
  }, tx);
}

export async function saveHomepageRecommendations(actorId: string, scope: HomepageScope, expectedRevision: number, raw: unknown) {
  const parsed = recommendationPolicyInput.safeParse(raw);
  if (!parsed.success) {
    const problem = parsed.error.issues[0];
    throw new OperationError(`${problem.path.join(".")} · ${problem.message}`);
  }
  const policy = parsed.data;
  await updateHomepageDraft(actorId, scope, expectedRevision, current => {
    if (!current && expectedRevision > 0) throw new OperationError("Save a valid homepage layout before changing recommendations.");
    const draft = current ?? (scopeKey(scope) === "global:default" ? defaultHomepage : { sections: [], hiddenSections: [] });
    return { ...draft, recommendations: Object.keys(policy).length ? policy : undefined };
  });
}

export async function publishHomepage(actorId: string, scope: HomepageScope, expectedRevision: number, restoreRelease?: string,
  tx?: Prisma.TransactionClient, options?: HomepageEditorOptions & { recommendationsOnly?: true }) {
  const key = scopeKey(scope);
  return withHomepageTransaction(tx, async tx => {
    await requireHomepageScope(actorId, scope, tx);
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${key}), 42)`;
    const row = await tx.homepageContent.findUnique({ where: { key },
      select: { revision: true, draft: true, published: { select: { content: true } } } });
    if (!row || row.revision !== expectedRevision) throw new OperationError("Save or reload the current draft before publishing.");
    const restored = restoreRelease && await tx.homepageRelease.findFirst({
      where: { scopeKey: key, id: restoreRelease }, select: { id: true, content: true },
    });
    if (restoreRelease && !restored) throw new OperationError("That release does not belong to this homepage scope.");
    const previous = homepageInput.safeParse(row.published?.content);
    const baseline = previous.data ?? (key === "global:default" ? defaultHomepage : null);
    const parsed = homepageInput.safeParse(restored ? restored.content : row.draft);
    if (!parsed.success) throw new OperationError("This version must be updated before publishing.");
    const content = options?.recommendationsOnly ? {
      ...(baseline ?? { sections: [], hiddenSections: [] }), recommendations: parsed.data.recommendations,
    } : parsed.data;
    assertMainAdminSections(baseline, content, options);
    validateSchedule(scope, content);
    await validateHomepageReferences(tx, scope, content, baseline, true);
    const release = await tx.homepageRelease.create({
      data: { actorId, scopeKey: key, content, ...(restored && { restoredFrom: restored.id }) },
      select: { id: true },
    });
    await tx.homepageContent.update({
      where: { key }, data: { publishedId: release.id, revision: { increment: 1 } },
    });
    await auditHomepageSections(tx, actorId, key, restored ? "homepage-release-restored" : "homepage-published", baseline, content,
      { revision: expectedRevision + 1, releaseId: release.id, ...(restored && { restoredFrom: restored.id }) });
    await auditRecommendationPolicy(tx, actorId, key, restored ? "recommendation-policy-restored" : "recommendation-policy-published",
      previous.data?.recommendations, content.recommendations,
      { revision: expectedRevision + 1, releaseId: release.id, ...(restored && { restoredFrom: restored.id }) });
    return { key, revision: expectedRevision + 1, releaseId: release.id };
  });
}

export function publishHomepageRecommendations(actorId: string, scope: HomepageScope, expectedRevision: number) {
  return publishHomepage(actorId, scope, expectedRevision, undefined, undefined, { recommendationsOnly: true });
}

export async function restoreInheritedHomepage(actorId: string, scope: HomepageScope, expectedRevision: number, tx: Prisma.TransactionClient) {
  const key = scopeKey(scope);
  await requireHomepageScope(actorId, scope, tx);
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${key}), 42)`;
  const row = await tx.homepageContent.findUnique({ where: { key }, select: { revision: true, publishedId: true } });
  if (row?.revision !== expectedRevision || !row.publishedId) throw new OperationError("The homepage changed. Reload before restoring inheritance.");
  await tx.homepageContent.update({ where: { key }, data: { publishedId: null, revision: { increment: 1 } } });
  await tx.auditEvent.create({ data: { action: "MERCHANDISING_REVIEW", actorId, target: key,
    changes: { step: "homepage-inheritance-restored", revision: expectedRevision + 1, previousReleaseId: row.publishedId } } });
  return { key, revision: expectedRevision + 1, releaseId: null };
}

export async function saveStaffMarketGrant(actorId: string, userId: string, marketId: MarketId, merchandising: boolean, reporting: boolean) {
  await getDb().$transaction(async tx => {
    await requireHomepageScope(actorId, {}, tx);
    const staff = await tx.staffAccess.findUnique({ where: { userId }, select: { active: true, role: true } });
    if (!staff?.active || staff.role === "OWNER") throw new OperationError("Choose an active non-owner staff account.");
    const key = { userId, marketId };
    if (!merchandising && !reporting) await tx.staffMarketAccess.updateMany({ where: key, data: { merchandising, reporting } });
    else await tx.staffMarketAccess.upsert({
      where: { userId_marketId: key }, create: { ...key, merchandising, reporting }, update: { merchandising, reporting },
    });
  });
}
