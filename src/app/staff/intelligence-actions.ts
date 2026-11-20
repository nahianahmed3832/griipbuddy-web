"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { reportFailure } from "@/lib/db/observability";
import { recordIntelligenceOutcome, saveIntelligenceDraft } from "@/lib/intelligence/drafts";
import { intelligencePath, intelligenceUrl } from "@/lib/intelligence/navigation";
import { requireStaff } from "@/lib/staff/access";
import { OperationError } from "@/lib/staff/operations";

type State = { message?: string };

export async function createIntelligenceDraftAction(_: State, form: FormData): Promise<State> {
  const staff = await requireStaff();
  const kind = z.enum(["COLLECTION", "PRODUCT_TEST", "PURCHASING"]).safeParse(form.get("kind"));
  if (!kind.success) return { message: "Choose a draft type." };
  let href: string;
  try {
    const evidence = await saveIntelligenceDraft(staff.id, kind.data, form.get("evidence"));
    href = intelligenceUrl({ market: evidence.marketId, scope: evidence.test ? "test" : "live", view: "drafts" });
  } catch (error) {
    if (error instanceof OperationError) return { message: error.message };
    reportFailure("intelligence.draft", undefined, error);
    return { message: "The draft is temporarily unavailable." };
  }
  revalidatePath(intelligencePath);
  redirect(href);
}

export async function observeIntelligenceDraftAction(_: State, form: FormData): Promise<State> {
  const staff = await requireStaff();
  try {
    const draft = await recordIntelligenceOutcome(staff.id, {
      id: form.get("id"), result: form.get("result"), from: form.get("from"), to: form.get("to"), note: form.get("note"),
    });
    revalidatePath(intelligencePath);
    return { message: draft.test ? "Fixture observation saved." : "Observation saved." };
  } catch (error) {
    if (error instanceof OperationError) return { message: error.message };
    reportFailure("intelligence.outcome", undefined, error);
    return { message: "The observation could not be saved." };
  }
}
