import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { readPublishedHomepage } from "../catalog/homepage-content.ts";
import { homepageInput, mergeHomepage, scopeKey, type HomepageContentData, type HomepageSection } from "../catalog/homepage-contract.ts";
import { resolveRecommendationPolicy } from "../catalog/recommendation-policy.ts";
import { marketConfiguration } from "../market-config.ts";
import { localMarketTime } from "../market-calendar.ts";
import { publishHomepage, restoreInheritedHomepage, saveHomepageDraft } from "../staff/homepage.ts";
import { OperationError } from "../staff/operations.ts";
import { workflowActionInputs } from "./action-input.ts";
import { workflowProductEligibility } from "./eligibility.ts";
import type { WorkflowContext, WorkflowResult } from "./types.ts";

const homepageDraftResult = z.object({ locale: z.string(), revision: z.int(), previousReleaseId: z.uuid().nullable(),
  productIds: z.array(z.string()).min(1).max(12), sectionKey: z.string().nullable(), startsAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(), placement: z.enum(["home-curated", "recommended"]) });
const homepagePublicationResult = homepageDraftResult.extend({ releaseId: z.uuid(), homepageConfig: z.string(),
  publishedAt: z.iso.datetime(), minimumImpressions: z.int().positive() });
const empty: HomepageContentData = { sections: [], hiddenSections: [] };

export type PreparedWorkflow = () => Promise<WorkflowResult>;

export async function prepareHomepageWorkflow({ tx, workflow, now }: WorkflowContext): Promise<PreparedWorkflow> {
  const { marketId, action, test, ownerId } = workflow;
  const market = marketConfiguration(marketId);
  const parsed = action === "HOME_DRAFT" ? workflowActionInputs.HOME_DRAFT.safeParse(workflow.payload)
    : action === "HOME_PUBLISH" ? workflowActionInputs.HOME_PUBLISH.safeParse(workflow.payload) : workflowActionInputs.HOME_ROLLBACK.safeParse(workflow.payload);
  if (!parsed.success) throw new OperationError("The homepage proposal is invalid. Update its action parameters.");
  const { locale } = parsed.data;
  if (!market.languages.includes(locale) || workflow.targetKey !== `homepage:${marketId}:${locale}`) {
    throw new OperationError("Choose the configured locale and homepage resource for this market.");
  }
  const scope = { marketId, locale };
  const key = scopeKey(scope);
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${key}), 42)`;
  const current = await tx.homepageContent.findUnique({ where: { key }, select: { revision: true, draft: true, publishedId: true,
    published: { select: { content: true } },
  } });
  const previousReleaseId = current?.publishedId ?? null;
  const base = homepageInput.parse(current?.published?.content ?? empty);
  const editorHref = `/staff/homepage?scope=${encodeURIComponent(key)}`;

  if ("productIds" in parsed.data) {
    const { productIds, sectionTitle, startsLocal, endsLocal, rankingPlacement } = parsed.data;
    if (current && !isDeepStrictEqual(homepageInput.parse(current.draft), base)) {
      throw new OperationError("This homepage scope has unpublished editor changes. Resolve them before creating an operational draft.");
    }
    const startsAt = startsLocal ? localMarketTime(startsLocal, market.timeZone) : null;
    const endsAt = endsLocal ? localMarketTime(endsLocal, market.timeZone) : null;
    if (startsLocal && !startsAt || endsLocal && !endsAt || endsAt && (endsAt <= now || startsAt && endsAt <= startsAt)) {
      throw new OperationError("Choose a valid local homepage schedule with a future end time.");
    }
    const products = await workflowProductEligibility(tx, { marketId, productIds, test, now, minimumStock: 1, requireDelivery: true });
    const inherited = await readPublishedHomepage(tx, marketId, locale);
    const sectionKey = rankingPlacement ? null : `wf-${workflow.id.slice(0, 12)}`;
    const placement = rankingPlacement ? "recommended" : "home-curated";
    let content: HomepageContentData;
    if (rankingPlacement) {
      const effective = resolveRecommendationPolicy(inherited.layers.map(layer => layer.recommendations)).placements[rankingPlacement];
      if (!effective.enabled || productIds.some(id => effective.excludes.includes(id))) throw new OperationError("The ranking placement or one of its products is excluded by the homepage policy.");
      const ordered = [...new Set([...productIds, ...effective.boosts])].slice(0, 24);
      content = { ...base, recommendations: { ...base.recommendations, placements: { ...base.recommendations?.placements,
        [rankingPlacement]: { ...base.recommendations?.placements?.[rankingPlacement], boosts: ordered },
      } } };
    } else {
      const section: HomepageSection = { key: sectionKey!, type: "CURATED", title: sectionTitle, position: 2,
        productIds, limit: productIds.length, startsLocal, endsLocal };
      if (mergeHomepage(inherited.layers).some(item => item.position < 2 && item.productIds?.some(id => productIds.includes(id)))) {
        throw new OperationError("A selected product already appears ahead of this slot. Choose a different product or a ranking draft.");
      }
      content = { ...base, sections: [...base.sections, section] };
    }
    const valid = homepageInput.safeParse(content);
    if (!valid.success) throw new OperationError("The proposed addition exceeds the homepage layout limit or has conflicting section keys.");
    return async () => {
      const saved = await saveHomepageDraft(ownerId, scope, current?.revision ?? 0, valid.data, tx);
      return { reference: `/staff/homepage/preview?${new URLSearchParams({ scope: key, market: marketId, locale, ...(startsLocal && { at: startsLocal }) })}`,
        details: { locale, revision: saved.revision, previousReleaseId, productIds, products, sectionKey,
          startsAt: startsAt?.toISOString() ?? null, endsAt: endsAt?.toISOString() ?? null, placement, draftOnly: true } };
    };
  }

  const sourceId = "draftWorkflowId" in parsed.data ? parsed.data.draftWorkflowId : parsed.data.publishWorkflowId;
  const source = await tx.operationalWorkflow.findUnique({ where: { id: sourceId } });
  if (!source || source.status !== "COMPLETED" || source.marketId !== marketId || source.test !== test || source.targetKey !== workflow.targetKey) {
    throw new OperationError("The referenced completed workflow is outside this homepage scope.");
  }
  if ("draftWorkflowId" in parsed.data) {
    if (source.evidenceExpiresAt <= now) throw new OperationError("The source draft evidence expired before publication. Start from a recent insight.");
    const saved = z.object({ details: homepageDraftResult }).transform(row => row.details).safeParse(source.result);
    if (source.action !== "HOME_DRAFT" || !saved.success || saved.data.locale !== locale ||
        saved.data.revision !== current?.revision || saved.data.previousReleaseId !== previousReleaseId) {
      throw new OperationError("The draft is no longer current. Review the homepage before publishing.");
    }
    if (saved.data.endsAt && new Date(saved.data.endsAt) <= now) throw new OperationError("The approved homepage schedule has already ended.");
    await workflowProductEligibility(tx, { marketId, test, now, productIds: saved.data.productIds, minimumStock: 1, requireDelivery: true });
    const { minimumImpressions } = parsed.data;
    return async () => {
      const release = await publishHomepage(ownerId, scope, saved.data.revision, undefined, tx);
      const { measurement } = await readPublishedHomepage(tx, marketId, locale);
      return { reference: editorHref, details: { ...saved.data, revision: release.revision, releaseId: release.releaseId,
        publishedAt: now.toISOString(), homepageConfig: measurement, minimumImpressions, draftWorkflowId: sourceId, draftOnly: false } };
    };
  }

  const published = z.object({ details: homepagePublicationResult }).transform(row => row.details).safeParse(source.result);
  if (source.action !== "HOME_PUBLISH" || !published.success || published.data.locale !== locale ||
      published.data.releaseId !== previousReleaseId || published.data.revision !== current?.revision) {
    throw new OperationError("A newer draft or publication exists. Use the homepage editor to review the rollback.");
  }
  return async () => {
    const { revision, previousReleaseId: restoreId, releaseId } = published.data;
    let restored;
    if (restoreId) {
      const prior = await tx.homepageRelease.findFirstOrThrow({ where: { id: restoreId, scopeKey: key }, select: { content: true } });
      restored = await publishHomepage(ownerId, scope, revision, restoreId, tx);
      await tx.homepageContent.update({ where: { key }, data: { draft: homepageInput.parse(prior.content) } });
    } else {
      restored = await restoreInheritedHomepage(ownerId, scope, revision, tx);
      await tx.homepageContent.update({ where: { key }, data: { draft: empty } });
    }
    return { reference: editorHref, details: { locale, revertedReleaseId: releaseId, restoredFrom: restoreId,
      releaseId: restored.releaseId, revision: restored.revision, publishWorkflowId: sourceId } };
  };
}

export { homepagePublicationResult };
