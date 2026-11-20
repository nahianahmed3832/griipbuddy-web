import { isDeepStrictEqual } from "node:util";
import { Prisma, type MerchandisingCandidate } from "../../generated/prisma/client.ts";
import { markets, type MarketId } from "../../config/markets.ts";
import { activeDiscount } from "../catalog/offer-price.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { productionMode } from "../release-config.ts";
import { catalogProduct, saveProduct } from "./catalog.ts";
import { mergeCatalogIdentifiers, productInput, validationMessage, type ProductInput } from "./catalog-input.ts";
import { csvLimit, parseCatalog, type CatalogConflict } from "./catalog-import.ts";
import { missingImage } from "./catalog-media.ts";
import { merchandisingEnabled } from "./merchandising-config.ts";
import { candidateId, digest, draftInput, evidenceInput, evidenceManifest, launchText, safeProductText, supplierRef, type EvidenceInput } from "./merchandising-input.ts";
import { priceWorksheet } from "./merchandising-pricing.ts";
import { authorize, lockProductEdits, OperationError } from "./operations.ts";
import { lockTaxonomy } from "./taxonomy-write.ts";

type Tx = Prisma.TransactionClient;
type Source = {
  supplier: string; externalId: string; file: string; fileDigest: string; importedAt: string; rows: number[];
  duplicateRows: number[]; conflicts: CatalogConflict[]; product: ProductInput; evidence: EvidenceInput; previousPublication: string;
};
type Draft = { product: ProductInput; evidence: EvidenceInput; resolution?: string; wording: "source" | "staff" | "model-assisted" };
type Approval = { revision: number; actor: string; at: string; markets: MarketId[]; digest: string };
type Launch = { revision: number; sourceVersion: string; market: MarketId; at: string; facts: string; method: "staff" | "model-assisted";
  text: ReturnType<typeof launchText>; attempt?: string };
const read = <T>(value: Prisma.JsonValue | null): T => value as T;
const data = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const own = (message?: string): never => { throw new OperationError(message ?? "Merchandising is unavailable."); };
const active = (product: ProductInput) => product.variants.filter((variant) => variant.active);

async function owner(db: DbReader, actor: string) {
  if (!merchandisingEnabled()) own();
  await authorize(db, actor, true);
}

async function audit(tx: Tx, actor: string, id: string, step: string, details: object) {
  await tx.auditEvent.create({ data: { action: "MERCHANDISING_REVIEW", actorId: actor, target: id, changes: data({ step, ...details }) } });
}

async function locked(tx: Tx, actor: string, id: string, revision: number) {
  await owner(tx, actor);
  if (!candidateId.safeParse(id).success) return own("Candidate unavailable.");
  await lockProductEdits(tx, "merchandising:" + id);
  const row = await tx.merchandisingCandidate.findUnique({ where: { id } });
  if (!row || row.revision !== revision) return own("The candidate changed. Reload it before continuing.");
  return row;
}

function validateDraft(raw: unknown): ProductInput {
  const parsed = draftInput.safeParse(raw);
  if (!parsed.success) return own(validationMessage(parsed.error));
  if (!safeProductText(parsed.data)) return own("Use plain product text without markup.");
  return parsed.data;
}

function fixDraft(product: ProductInput, previous?: ProductInput) {
  const prepared = mergeCatalogIdentifiers(product, previous);
  const supplied = new Map(prepared.variants.map((variant) => [variant.sku, variant]));
  const variants = previous ? [
    ...previous.variants.map((variant) => supplied.get(variant.sku) ?? variant),
    ...prepared.variants.filter((variant) => !previous.variants.some((old) => old.sku === variant.sku)),
  ] : prepared.variants;
  return validateDraft({ ...prepared, publication: "DRAFT", demo: previous?.demo ?? true, variants });
}

export async function importCandidates(actor: string, supplierValue: unknown, file: string, csv: string, manifest: unknown) {
  const db = getDb();
  await owner(db, actor);
  const supplier = supplierRef.safeParse(supplierValue);
  const supplied = evidenceManifest.safeParse(manifest);
  if (!supplier.success || !supplied.success) return own("Use a supplier reference and a valid evidence manifest.");
  if (Buffer.byteLength(csv) > csvLimit) return own("Use a catalog CSV of up to 256 KB.");
  const { groups, issues } = parseCatalog(csv, true);
  for (const key of Object.keys(supplied.data)) if (!groups.has(key)) issues.push({ row: 1, message: `Evidence has no CSV product named ${key}.` });
  if (issues.length) return { issues, entries: [] };
  const entries: { id: string; product: string; change: string; revision: number; duplicateRows: number[] }[] = [];
  const fileDigest = digest(csv);
  for (const [productId, group] of groups) {
    const evidence = supplied.data[productId] ?? evidenceInput.parse({});
    const externalId = evidence.sourceProductId ?? productId;
    const id = digest(["merchandising", supplier.data.toLowerCase(), externalId.toLowerCase()]);
    try {
      const entry = await db.$transaction(async (tx) => {
        await owner(tx, actor);
        await lockProductEdits(tx, "merchandising:" + id);
        await lockProductEdits(tx, productId);
        const existing = await tx.merchandisingCandidate.findUnique({ where: { id } });
        if (existing && existing.productId !== productId) own("This supplier record is already linked to another catalog ID.");
        const conflicting = await tx.merchandisingCandidate.findFirst({ where: { productId, id: { not: id } }, select: { id: true } });
        if (conflicting) own("This catalog product has a candidate from a different source. Review that source before changing it.");
        const legacy = await catalogProduct(tx, productId);
        const product = fixDraft(group.product, legacy?.product);
        const sourceVersion = digest([group.product, evidence, group.conflicts.map(({ field, earlier, incoming }) => [field, earlier, incoming])]);
        if (existing?.sourceVersion === sourceVersion) return {
          id, product: product.name, change: "Unchanged", revision: existing.revision, duplicateRows: group.duplicates,
        };
        const source: Source = { supplier: supplier.data, externalId, file: file.slice(0, 120), fileDigest, importedAt: new Date().toISOString(),
          rows: group.rows, duplicateRows: group.duplicates, conflicts: group.conflicts, product: group.product, evidence,
          previousPublication: group.product.publication };
        const draft: Draft = { product, evidence, wording: "source" };
        const base = legacy && !existing?.ownsDraft ? { baseline: data(legacy.product), baseRevision: legacy.revision } :
          legacy?.product.publication === "ACTIVE" ? { baseline: data(legacy.product) } : {};
        const stored = await tx.merchandisingCandidate.upsert({
          where: { id }, create: { id, productId, source: data(source), sourceVersion, draft: data(draft), ownsDraft: !legacy, ...base },
          update: { source: data(source), sourceVersion, draft: data(draft), decision: "pending", approval: Prisma.DbNull,
            publishedAt: null, revision: { increment: 1 }, ...base },
        });
        await audit(tx, actor, id, "source-imported", { sourceVersion, revision: stored.revision, file: source.file, rows: source.rows,
          ...(existing && { replacedSource: existing.source, replacedVersion: existing.sourceVersion }) });
        return { id, product: product.name, change: existing ? "Source updated" : "Created", revision: stored.revision, duplicateRows: group.duplicates };
      });
      entries.push(entry);
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      issues.push({ row: group.rows[0], message: error.message });
    }
  }
  return { entries, issues };
}

export async function takeExisting(actor: string, id: string) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    await owner(tx, actor);
    await lockProductEdits(tx, id);
    const prior = await tx.merchandisingCandidate.findFirst({ where: { productId: id } });
    if (prior) return prior.id;
    const snapshot = await catalogProduct(tx, id);
    if (!snapshot) return own("The catalog product is unavailable.");
    const candidate = digest(["merchandising", "catalog", id]);
    const evidence = evidenceInput.parse({ sourceRecord: id, sourceProductId: id });
    const source: Source = { supplier: "GriipBuddy catalog", externalId: id, file: "Catalog editor", fileDigest: digest(snapshot.product),
      importedAt: new Date().toISOString(), rows: [], duplicateRows: [], conflicts: [], product: snapshot.product, evidence,
      previousPublication: snapshot.product.publication };
    const draft: Draft = { product: fixDraft(snapshot.product, snapshot.product), evidence, wording: "source" };
    await tx.merchandisingCandidate.create({ data: { id: candidate, productId: id, source: data(source), sourceVersion: source.fileDigest,
      draft: data(draft), baseline: data(snapshot.product), baseRevision: snapshot.revision } });
    await audit(tx, actor, candidate, "catalog-snapshot", { sourceVersion: source.fileDigest, productId: id, baseRevision: snapshot.revision });
    return candidate;
  });
}

export function candidateView(row: MerchandisingCandidate) {
  return { ...row, source: read<Source>(row.source), draft: read<Draft>(row.draft),
    approval: read<Approval | null>(row.approval), baseline: read<ProductInput | null>(row.baseline), launch: read<Launch[] | null>(row.launch) ?? [] };
}

export async function candidates(actor: string) {
  const db = getDb();
  await owner(db, actor);
  return (await db.merchandisingCandidate.findMany({ orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 60 })).map(candidateView);
}

export async function candidate(actor: string, id: string) {
  const db = getDb();
  await owner(db, actor);
  if (!candidateId.safeParse(id).success) return null;
  const row = await db.merchandisingCandidate.findUnique({ where: { id } });
  return row ? candidateView(row) : null;
}

export async function amendCandidate(
  actor: string, id: string, revision: number, changes: { draft?: unknown; evidence?: unknown; resolution?: string; attempt?: string },
) {
  return getDb().$transaction(async (tx) => {
    const row = await locked(tx, actor, id, revision);
    const current = candidateView(row);
    const product = changes.draft === undefined ? current.draft.product :
      validateDraft(mergeCatalogIdentifiers(validateDraft(changes.draft), current.draft.product));
    if (product.id !== row.productId || product.demo !== current.draft.product.demo) own("Keep the catalog ID and staging classification.");
    const parsed = evidenceInput.safeParse(changes.evidence ?? current.draft.evidence);
    if (!parsed.success) return own(validationMessage(parsed.error));
    const evidence = parsed.data;
    if (evidence.sourceProductId && evidence.sourceProductId !== current.source.externalId) own("Keep the supplier product identifier from the imported source.");
    const resolution = changes.resolution?.trim().slice(0, 1000) ?? current.draft.resolution;
    const draft: Draft = { product, evidence, resolution, wording: changes.attempt ? "model-assisted" : changes.draft ? "staff" : current.draft.wording };
    if (isDeepStrictEqual(data(draft), data(current.draft))) return current;
    const baseline = row.publishedAt ? (await catalogProduct(tx, row.productId))?.product : undefined;
    const saved = await tx.merchandisingCandidate.update({ where: { id }, data: {
      draft: data(draft), decision: "pending", approval: Prisma.DbNull, publishedAt: null, revision: { increment: 1 },
      ...(baseline && { baseline: data(baseline) }),
    } });
    await audit(tx, actor, id, "draft-edited", { revision: saved.revision, prior: current.draft, stepAttempt: changes.attempt ?? null });
    return candidateView(saved);
  });
}

type View = ReturnType<typeof candidateView>;
export const intendedMarkets = (draft: Draft): MarketId[] => {
  const recorded = draft.evidence.markets.map((item) => item.market);
  const offers = [...new Set(active(draft.product).flatMap((variant) => variant.offers.filter((offer) => offer.eligible).map((offer) => offer.marketId)))];
  return recorded.length ? recorded : offers.length ? offers : ["bd"];
};

export function reviewedFacts(view: View) {
  return view.draft.product.specifications.map((item) => {
    const prepared = view.draft.evidence.confirmations.find(({ field, value }) => field.toLowerCase() === item.label.toLowerCase() && value === item.value);
    const isSource = view.source.product.specifications.some(({ label, value }) => label === item.label && value === item.value);
    return { ...item, status: prepared?.status ?? (isSource ? "supplier" : "missing"),
      evidence: prepared?.evidence ?? (isSource ? (view.source.evidence.sourceRecord ?? view.source.file + (view.source.rows.length ? ` · rows ${view.source.rows.join(", ")}` : "")) : undefined) };
  });
}

export async function readiness(db: DbReader, view: View) {
  const { product, evidence, resolution } = view.draft;
  const global: string[] = [];
  const validation = productInput.safeParse({ ...product, publication: "ACTIVE" });
  if (!validation.success) global.push(...validation.error.issues.filter(({ message }) =>
    !message.includes("eligible market")).map(({ message }) => message));
  if (!await db.department.findUnique({ where: { id: product.departmentId }, select: { id: true } })) global.push("Choose a catalog category.");
  if (await db.collection.count({ where: { id: { in: product.collectionIds } } }) !== product.collectionIds.length) global.push("Review the selected collections.");
  const slug = await db.product.findFirst({ where: { slug: product.slug, id: { not: product.id } }, select: { id: true } });
  if (slug) global.push("The URL slug belongs to another catalog product.");
  const skus = product.variants.map(({ sku }) => sku);
  const collisions = await db.variant.findMany({ where: { productId: { not: product.id }, sku: { in: skus, mode: "insensitive" } }, select: { sku: true } });
  if (collisions.length) global.push("SKU already in use: " + collisions.map(({ sku }) => sku).join(", "));
  const paths = [...product.images, ...product.variants.flatMap(({ image }) => image ? [image] : [])].map(({ src }) => src);
  if (paths.some((src) => !evidence.images.some((photo) => photo.src === src))) global.push("Attach an approval and usage reference for every listed image.");
  if (await missingImage(db, paths)) global.push("A listed image file is unavailable.");
  if (reviewedFacts(view).some((fact) => !fact.evidence)) global.push("Attach evidence to corrected or added product attributes.");
  if (view.source.conflicts.length && !resolution) global.push("Resolve the conflicting source fields and record the decision.");
  const current = await db.product.findUnique({ where: { id: product.id }, select: { revision: true, publication: true } });
  const expected = view.ownsDraft ? view.catalogRevision : view.baseRevision;
  const catalogChanged = (current?.revision ?? null) !== expected;
  if (catalogChanged) global.push("The catalog changed since this candidate was prepared. Refresh the catalog baseline.");
  const intended = intendedMarkets(view.draft);
  const policies = await db.checkoutPolicy.findMany({ where: { marketId: { in: intended } }, include: { deliveryZones: true } });
  const ranks = intended.map((market) => {
    const policy = policies.find((item) => item.marketId === market);
    const recorded = evidence.markets.find((item) => item.market === market);
    const marketGaps: string[] = [];
    if (!policy?.enabled || policy.currency !== markets[market].currency) marketGaps.push("Checkout is closed or the currency is unconfigured.");
    if (!policy?.codEnabled || !policy.deliveryZones.some((zone) => zone.enabled && zone.codEligible && zone.chargeMinor !== null)) {
      marketGaps.push("No eligible delivery option for checkout.");
    }
    if (!recorded?.delivery) marketGaps.push("Add a product delivery eligibility reference.");
    if (!recorded?.content) marketGaps.push("Review market content in the store language.");
    if (!recorded?.decision) marketGaps.push("Record the market eligibility decision.");
    for (const variant of active(product)) if (!variant.offers.some((offer) =>
      offer.marketId === market && offer.currency === markets[market].currency && offer.eligible)) {
      marketGaps.push(`Add an eligible ${markets[market].currency} price for ${variant.sku}.`);
    }
    return { market, marketGaps, ready: marketGaps.length === 0,
      policyVersion: digest([policy?.revision, policy?.deliveryZones.map(({ district, method, revision }) => [district, method, revision]).sort()]) };
  });
  return { global, markets: ranks, catalogChanged, product, current, ready: global.length === 0 && ranks.some((row) => row.ready) };
}

function approvalDigest(view: View, status: Awaited<ReturnType<typeof readiness>>, scope: MarketId[]) {
  return digest([view.revision, view.sourceVersion, view.draft, scope.map((market) => [market, status.markets.find((row) => row.market === market)?.policyVersion])]);
}

export function approvalCurrent(view: View, status: Awaited<ReturnType<typeof readiness>>) {
  const scope = status.markets.filter(({ ready }) => ready).map(({ market }) => market);
  return Boolean(status.ready && view.decision === "approved" && view.approval?.digest === approvalDigest(view, status, scope));
}

export async function reviewCandidate(actor: string, id: string, revision: number, action: "approve" | "reject" | "refresh" | "transfer" | "publish", reason?: string,
  expectedScope?: MarketId[]) {
  return getDb().$transaction(async (tx) => {
    if (action === "transfer" || action === "publish") await lockTaxonomy(tx);
    const row = await locked(tx, actor, id, revision);
    const view = candidateView(row);
    await lockProductEdits(tx, row.productId);
    if (action === "refresh") {
      const current = await catalogProduct(tx, row.productId);
      if (!current) own("The catalog baseline is unavailable.");
      const saved = await tx.merchandisingCandidate.update({ where: { id }, data: {
        ...(row.ownsDraft ? { catalogRevision: current!.revision } : { baseRevision: current!.revision }), baseline: data(current!.product),
        approval: Prisma.DbNull, publishedAt: null, decision: "pending", revision: { increment: 1 },
      } });
      await audit(tx, actor, id, action, { revision: saved.revision, catalogRevision: current!.revision });
      return candidateView(saved);
    }
    if (action === "reject") {
      if (!reason?.trim()) own("Record a rejection reason.");
      const saved = await tx.merchandisingCandidate.update({ where: { id }, data: { decision: "rejected", approval: Prisma.DbNull, revision: { increment: 1 } } });
      await audit(tx, actor, id, action, { reason: reason?.trim().slice(0, 600), revision: row.revision, draft: view.draft });
      return candidateView(saved);
    }
    // Market settings take these same locks before changing checkout or delivery.
    for (const market of [...intendedMarkets(view.draft)].sort()) {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${market}), 38)`;
    }
    const status = await readiness(tx, view);
    if (action === "publish" && row.publishedAt && approvalCurrent(view, status)) return view;
    const scope = status.markets.filter(({ ready }) => ready).map(({ market }) => market);
    if (!status.ready) own("Resolve the listing checks and at least one market before approving or publishing.");
    const fingerprint = approvalDigest(view, status, scope);
    if (action === "approve") {
      if (expectedScope && !isDeepStrictEqual([...scope].sort(), [...expectedScope].sort())) own("Market eligibility changed. Review the updated scope before approving.");
      if (view.decision === "rejected") own("Save a revision of the rejected draft before approving.");
      if (view.approval?.digest === fingerprint && view.decision === "approved") return view;
      const approval = { actor, at: new Date().toISOString(), revision, markets: scope, digest: fingerprint };
      const saved = await tx.merchandisingCandidate.update({ where: { id }, data: { decision: "approved", approval: data(approval) } });
      await audit(tx, actor, id, action, { approval, sourceVersion: view.sourceVersion, draft: view.draft });
      return candidateView(saved);
    }
    if (!approvalCurrent(view, status)) own("Review and approve the current listing and market facts first.");
    const privateDraft = row.ownsDraft && status.current?.publication !== "ACTIVE";
    if (action === "transfer" && (!privateDraft || row.stagedRevision === row.revision)) return view;
    if (action === "publish" && privateDraft && row.stagedRevision !== row.revision) own("Transfer this approved version into the catalog first.");
    if (productionMode()) own("Publish through the staging catalog for this release.");
    const desired: ProductInput = { ...view.draft.product, publication: action === "publish" ? "ACTIVE" : "DRAFT",
      variants: view.draft.product.variants.map((variant) => ({ ...variant,
        offers: variant.offers.map((offer) => ({ ...offer, eligible: offer.eligible && scope.includes(offer.marketId) })),
      })) };
    await saveProduct(actor, desired, status.current?.revision ?? null, "merchandising", tx);
    const actual = await tx.product.findUniqueOrThrow({ where: { id: row.productId }, select: { revision: true } });
    const saved = await tx.merchandisingCandidate.update({ where: { id }, data: {
      ...(row.ownsDraft ? { catalogRevision: actual.revision } : { baseRevision: actual.revision }),
      ...(action === "transfer" && { stagedRevision: row.revision }),
      ...(action === "publish" && { publishedAt: new Date() }),
    } });
    await audit(tx, actor, id, action, { revision, scope, catalogRevision: actual.revision, approval: view.approval });
    return candidateView(saved);
  }, { timeout: 15_000 });
}

export async function batchReview(actor: string, inputs: { id: string; revision: number; scope?: MarketId[] }[]) {
  await owner(getDb(), actor);
  if (!inputs.length || inputs.length > 25 || new Set(inputs.map(({ id }) => id)).size !== inputs.length) own("Select 1 to 25 different candidates.");
  const results: { id: string; approved: boolean; reason?: string }[] = [];
  for (const { id, revision, scope } of inputs) {
    try {
      await reviewCandidate(actor, id, revision, "approve", undefined, scope);
      results.push({ id, approved: true });
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      results.push({ id, approved: false, reason: error.message });
    }
  }
  return results;
}

export function pricing(view: View, market: MarketId) {
  return active(view.draft.product).map((variant) => priceWorksheet(variant, market, view.draft.evidence.scenarios.find((row) =>
    row.market === market && row.sku.toUpperCase() === variant.sku)));
}

export async function launchContext(db: DbReader, view: View, market: MarketId) {
  const now = new Date();
  const live = await db.product.findUnique({ where: { id: view.productId }, select: { revision: true, publication: true,
    variants: { select: { sku: true, active: true, inventory: { select: { available: true } }, offers: { where: { marketId: market } } } },
  } });
  const destination = live?.publication === "ACTIVE" && live.variants.some((variant) => variant.active && variant.offers.some(({ eligible }) => eligible)) &&
    view.publishedAt && view.approval?.revision === view.revision
    ? "/products/" + view.draft.product.slug : undefined;
  const facts = digest([view.sourceVersion, view.revision, view.approval?.digest, live?.revision, live?.publication,
    live?.variants.map(({ sku, active, inventory, offers }) => ({ sku, active, stock: inventory?.available ?? 0,
      offers: offers.map((offer) => [offer.amountMinor, activeDiscount(offer, now), offer.currency, offer.eligible]) })).sort((a, b) => a.sku.localeCompare(b.sku))]);
  return { facts, destination };
}

export async function launchDrafts(db: DbReader, view: View, approved: boolean) {
  return Promise.all(view.launch.map(async (item) => ({ ...item, stale: !approved || item.facts !== (await launchContext(db, view, item.market)).facts })));
}

export async function previewCatalog(db: DbReader, view: View, market: MarketId) {
  const { product, evidence } = view.draft;
  const live = await db.variant.findMany({ where: { productId: product.id },
    select: { id: true, sku: true, inventory: { select: { available: true } } } });
  const forPreview = (image: ProductInput["images"][number]) => evidence.images.some((row) => row.src === image.src) ? image : undefined;
  const variants = active(product).map((variant, index) => {
    const current = live.find((row) => row.sku === variant.sku);
    const id = current?.id ?? `preview-${index}`;
    const offer = variant.offers.find((row) => row.marketId === market && row.eligible && row.currency === markets[market].currency);
    return { id, options: variant.options, image: variant.image && forPreview(variant.image),
      offer: offer ? { variantId: id, marketId: market, currency: offer.currency, amountMinor: offer.amountMinor,
        stock: current?.inventory?.available ?? 0 } : null };
  });
  const images = product.images.flatMap((image) => forPreview(image) ?? []);
  if (!variants.length || !(images.length || variants.every((variant) => variant.image))) return null;
  if (await missingImage(db, [...images, ...variants.flatMap((variant) => variant.image ?? [])].map(({ src }) => src))) return null;
  return { id: product.id, slug: product.slug, name: product.name, departmentId: product.departmentId, description: product.description,
    specifications: product.specifications, keywords: product.keywords, images, variants,
    addedOn: view.createdAt.toISOString().slice(0, 10), demo: product.demo };
}

export async function saveLaunch(actor: string, id: string, revision: number, market: MarketId,
  focus?: number[], angle: "details" | "options" = "details", attempt?: string, expectedFacts?: string) {
  return getDb().$transaction(async (tx) => {
    const row = await locked(tx, actor, id, revision);
    const view = candidateView(row);
    await lockProductEdits(tx, view.productId);
    const status = await readiness(tx, view);
    if (!approvalCurrent(view, status) || !view.approval?.markets.includes(market)) own("Approve the current candidate for this market first.");
    const context = await launchContext(tx, view, market);
    if (expectedFacts && context.facts !== expectedFacts) own("Price or availability changed. Request a fresh launch draft.");
    const text = launchText(view.draft.product, market, focus ?? view.draft.product.specifications.slice(0, 2).map((_, i) => i), angle, context.destination);
    const entry: Launch = { revision, sourceVersion: row.sourceVersion, market, at: new Date().toISOString(), facts: context.facts,
      method: attempt ? "model-assisted" : "staff", text, attempt };
    if (view.launch.some((item) => item.market === market && item.facts === entry.facts && item.attempt === attempt && isDeepStrictEqual(item.text, entry.text))) return entry;
    await tx.merchandisingCandidate.update({ where: { id }, data: { launch: data([...view.launch.filter((item) => item.market !== market), entry]) } });
    await audit(tx, actor, id, "launch-saved", { ...entry });
    return entry;
  });
}
