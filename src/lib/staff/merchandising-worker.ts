import { z } from "zod";
import { markets, type MarketId } from "../../config/markets.ts";
import { getDb } from "../db/client.ts";
import { catalogChoices } from "./catalog.ts";
import { amendCandidate, approvalCurrent, candidate, intendedMarkets, launchContext, readiness, reviewedFacts, saveLaunch } from "./merchandising.ts";
import { candidateId, digest, listingText } from "./merchandising-input.ts";
import { OperationError } from "./operations.ts";

const route = "/api/v1/operations-catalog";
const selection = z.object({
  type: z.enum(["merchandising-listing", "merchandising-launch"]), focus: z.array(z.number().int().nonnegative()).max(5),
  category: z.string().nullable(), collections: z.array(z.string()).max(3), angle: z.enum(["details", "options"]),
});
const response = z.object({
  id: candidateId, state: z.string(), reason: z.string().nullish(), version: candidateId.optional(),
  latest: z.object({ _id: candidateId, method: z.literal("provider"), dataVersion: candidateId, output: selection }).nullish(),
});
type Intent = "listing" | "launch";

function connection() {
  const origin = process.env.GRIIP_MERCHANDISING_RUNNER;
  const token = process.env.GRIIP_MERCHANDISING_TOKEN;
  // Both destinations are deployment-owned and use the isolated networks.
  if (!origin || !/^http:\/\/(?:127\.0\.0\.1:[0-9]{4,5}|operations-api:38100)$/.test(origin) ||
    !/^[a-f0-9]{64}$/.test(token ?? "")) throw new OperationError("Connect the private workforce runner to request AI drafting.");
  return { origin, token };
}

async function request(path: string, body?: object) {
  const { origin, token } = connection();
  try {
    const result = await fetch(origin + route + path, {
      method: body ? "POST" : "GET", signal: AbortSignal.timeout(5500), redirect: "error", cache: "no-store",
      headers: { Authorization: "Bearer " + token, ...(body && { "Content-Type": "application/json" }) },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (!result.ok) throw new OperationError(result.status === 422 ? "Reduce the catalog material to fit the worker’s input limit." :
      "The private workforce runner could not accept this request.");
    const parsed = response.safeParse(await result.json());
    if (!parsed.success) throw new OperationError("The private workforce runner returned an invalid record.");
    return parsed.data;
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError("The private workforce runner is unavailable.");
  }
}

async function scoped(actor: string, id: string, revision: number, intent: Intent, market: MarketId) {
  const view = await candidate(actor, id);
  if (!view || view.revision !== revision || !intendedMarkets(view.draft).includes(market)) {
    throw new OperationError("Select an intended market and the current candidate version.");
  }
  if (intent === "launch" && (!view.approval?.markets.includes(market) || !approvalCurrent(view, await readiness(getDb(), view)))) {
    throw new OperationError("Approve the current candidate for this market first.");
  }
  const choices = await catalogChoices(actor);
  const { product } = view.draft;
  const facts = (intent === "listing" ? reviewedFacts(view).filter((fact) => fact.evidence) : product.specifications)
    .map(({ label, value }) => ({ label, value }));
  const select = (rows: { id: string; name: string }[]) => rows.slice(0, 25).map(({ id, name }) => ({ id, name }));
  const material = { name: product.name, facts, categories: select(choices.departments), collections: select(choices.collections),
    category: product.departmentId, marketName: markets[market].name,
    ...(intent === "listing" && product.description && { description: product.description.slice(0, 1600) }) };
  const marketState = intent === "launch" ? (await launchContext(getDb(), view, market)).facts : null;
  const version = digest([id, view.sourceVersion, revision, intent, market, material, marketState]);
  return { view, material, version, marketState };
}

export async function queueMerchandising(actor: string, id: string, revision: number, intent: Intent, market: MarketId) {
  const { view, material, version } = await scoped(actor, id, revision, intent, market);
  return request("", { candidate: id, sourceVersion: view.sourceVersion, version, revision, market, intent, material });
}

export async function workStatus(actor: string, id: string, task: string) {
  if (!candidateId.safeParse(task).success || !await candidate(actor, id)) throw new OperationError("Work record unavailable.");
  return request(`/${id}/${task}`);
}

export async function applyMerchandising(actor: string, id: string, revision: number, intent: Intent, market: MarketId, task: string) {
  const [{ view, version, material, marketState }, record] = await Promise.all([
    scoped(actor, id, revision, intent, market), workStatus(actor, id, task),
  ]);
  const result = record.latest;
  if (result?.dataVersion !== version || record.version !== version || result.output.type !== `merchandising-${intent}`) {
    throw new OperationError("Run the worker again against this candidate version and market.");
  }
  const { angle, category, collections, focus } = result.output;
  if (focus.some((index) => !material.facts[index]) || (category && !material.categories.some(({ id }) => id === category)) ||
    collections.some((choice) => !material.collections.some(({ id }) => id === choice))) throw new OperationError("Review the current catalog choices.");
  if (intent === "launch") return saveLaunch(actor, id, revision, market, focus, angle, result._id, marketState ?? undefined);
  return amendCandidate(actor, id, revision, {
    draft: { ...view.draft.product, ...listingText(view.draft.product.name, material.facts, focus),
      departmentId: category ?? view.draft.product.departmentId,
      collectionIds: collections.length ? collections : view.draft.product.collectionIds },
    attempt: result._id,
  });
}
