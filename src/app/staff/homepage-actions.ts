"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isMarketId } from "@/config/markets";
import { invalidateHomepagePublication } from "@/lib/catalog/homepage-cache";
import { parseHomepageScope } from "@/lib/catalog/homepage-contract";
import { mainAdminHomepageRequested } from "@/lib/catalog/main-admin-config";
import { recommendationPlacements } from "@/lib/catalog/recommendation-policy";
import { reportFailure } from "@/lib/db/observability";
import { getStaff } from "@/lib/staff/access";
import { publishHomepage, publishHomepageRecommendations, saveHomepageDraft, saveHomepageRecommendations, saveStaffMarketGrant } from "@/lib/staff/homepage";
import { OperationError } from "@/lib/staff/operations";

async function run(command: (actorId: string) => Promise<unknown>, success: string, publication = false) {
  const actor = await getStaff();
  if (!actor) return { error: "Sign in to manage the homepage." };
  try {
    await command(actor.id);
    revalidatePath("/staff/homepage");
    revalidatePath("/staff/homepage/preview");
    revalidatePath("/staff/homepage/recommendations");
    if (publication) invalidateHomepagePublication();
    return { success };
  } catch (error) {
    if (error instanceof OperationError) return { error: error.message };
    reportFailure("staff.homepage", undefined, error);
    return { error: "The homepage couldn’t be updated. Try again." };
  }
}

export async function saveHomepageAction(key: string, revision: number, _previous: unknown, form: FormData) {
  if (mainAdminHomepageRequested()) return { error: "Manage homepage sections from the main GriipBuddy admin." };
  const scope = parseHomepageScope(key);
  const content = form.get("content");
  if (!scope || !Number.isInteger(revision) || typeof content !== "string" || content.length > 30_000) return { error: "The draft is invalid." };
  let input: unknown;
  try { input = JSON.parse(content); } catch { return { error: "The draft is invalid." }; }
  return run(actor => saveHomepageDraft(actor, scope, revision, input), "Draft saved.");
}

function optionalField(form: FormData, name: string) {
  return form.get(name) || undefined;
}

function optionalToggledField(form: FormData, name: string) {
  const value = optionalField(form, name);
  return value === "enabled" ? true : value === "disabled" ? false : value;
}

function optionalProducts(form: FormData, name: string) {
  if (!form.has(`${name}-override`)) return undefined;
  const field = form.get(name);
  if (typeof field !== "string" || field.length > 2_424) return field;
  return field.split(/[\s,]+/).filter(Boolean);
}

export async function saveRecommendationPolicyAction(key: string, revision: number, _previous: unknown, form: FormData) {
  const scope = parseHomepageScope(key);
  if (!scope || !Number.isInteger(revision) || revision < 0) return { error: "The recommendation draft is invalid." };
  const behavioralEnabled = optionalToggledField(form, "behavioral");
  const placements = Object.fromEntries(recommendationPlacements.flatMap(placement => {
    const fields = Object.fromEntries([
      ["enabled", optionalToggledField(form, `${placement}-enabled`)],
      ["strategy", optionalField(form, `${placement}-strategy`)],
      ...["boosts", "excludes", "fallback", ...(placement === "buy-again" ? ["replenishable"] : [])]
        .map(field => [field, optionalProducts(form, `${placement}-${field}`)]),
    ].filter(([, value]) => value !== undefined));
    return Object.keys(fields).length ? [[placement, fields]] : [];
  }));
  const policy = {
    ...(behavioralEnabled !== undefined && { behavioralEnabled }),
    ...(Object.keys(placements).length > 0 && { placements }),
  };
  return run(actor => saveHomepageRecommendations(actor, scope, revision, policy), "Recommendation draft saved.");
}

export async function publishHomepageAction(key: string, revision: number, _previous: unknown, form: FormData) {
  const scope = parseHomepageScope(key);
  const restore = form.get("release");
  if (!scope || !Number.isInteger(revision) || (restore !== null && !z.uuid().safeParse(restore).success)) {
    return { error: "The release is invalid." };
  }
  if (mainAdminHomepageRequested()) {
    if (restore) return { error: "Restore homepage releases from the main GriipBuddy admin." };
    return run(actor => publishHomepageRecommendations(actor, scope, revision), "Recommendation policy published.", true);
  }
  return run(actor => publishHomepage(actor, scope, revision, typeof restore === "string" ? restore : undefined),
    restore ? "Earlier version restored and published." : "Homepage published.", true);
}

export async function saveMarketGrantAction(_previous: unknown, form: FormData) {
  const userId = form.get("user");
  const marketId = form.get("market");
  if (typeof userId !== "string" || !userId || userId.length > 128 || !isMarketId(marketId)) return { error: "Choose a staff account and market." };
  return run(actor => saveStaffMarketGrant(actor, userId, marketId, form.has("merchandising"), form.has("reporting")), "Market access saved.");
}
