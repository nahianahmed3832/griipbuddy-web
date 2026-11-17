import { z } from "zod";
import { reportFailure } from "../db/observability.ts";
import { csvLimit } from "./catalog-import.ts";
import { amendCandidate, batchReview, importCandidates, reviewCandidate, saveLaunch, takeExisting } from "./merchandising.ts";
import { candidateId, marketId } from "./merchandising-input.ts";
import { applyMerchandising, queueMerchandising } from "./merchandising-worker.ts";
import { OperationError } from "./operations.ts";

const path = "/staff/catalog/merchandising";
export type Feedback = {
  error?: string; success?: string; receipt?: { id: string; message: string; ok: boolean }[]; candidate?: string; href?: string;
};
const decision = z.enum(["approve", "reject", "refresh", "transfer", "publish", "staff-launch", "queue-listing", "queue-launch", "apply-listing", "apply-launch"]);

async function intake(actor: string, form: FormData): Promise<Feedback> {
  const file = form.get("catalog");
  const evidence = form.get("evidence");
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".csv") || file.size < 1 || file.size > csvLimit) {
    return { error: "Choose a catalog CSV of up to 256 KB." };
  }
  let manifest = {};
  if (evidence instanceof File && evidence.size) {
    if (evidence.size > 128_000 || !evidence.name.toLowerCase().endsWith(".json")) return { error: "Choose an evidence JSON file up to 128 KB." };
    try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await evidence.arrayBuffer())); }
    catch { return { error: "The evidence file must use UTF-8 JSON." }; }
  }
  let csv: string;
  try { csv = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
  catch { return { error: "The catalog CSV must use UTF-8." }; }
  const result = await importCandidates(actor, form.get("supplier"), file.name, csv, manifest);
  return { receipt: [
    ...result.entries.map((entry) => ({ id: entry.id, message: `${entry.product} · ${entry.change}${entry.duplicateRows.length ? ` · repeated rows ${entry.duplicateRows.join(", ")}` : ""}`, ok: true })),
    ...result.issues.map(({ row, message }, index) => ({ id: `row-${index}`, message: `Row ${row} · ${message}`, ok: false })),
  ] };
}

async function batch(actor: string, form: FormData): Promise<Feedback> {
  const selection = z.array(z.string().regex(/^[a-f0-9]{64}:\d{1,10}:(?:bd|us)(?:,(?:bd|us))?$/)).min(1).max(25).safeParse(form.getAll("selection"));
  if (!selection.success) return { error: "Select 1 to 25 candidate versions." };
  const picked = selection.data.map((entry) => {
    const [id, revision, scope] = entry.split(":");
    return { id, revision: Number(revision), scope: marketId.array().min(1).max(2).parse(scope.split(",")) };
  });
  const result = await batchReview(actor, picked);
  return { receipt: result.map((entry) => ({ id: entry.id, ok: entry.approved, message: entry.approved ? "Approved" : entry.reason ?? "Review required" })) };
}

export async function handleMerchandising(actor: string, form: FormData): Promise<Feedback> {
  try {
    const operation = form.get("operation");
    if (operation === "intake") return await intake(actor, form);
    if (operation === "existing") return { href: path + "/" + await takeExisting(actor, String(form.get("product") ?? "").trim().slice(0, 80)) };
    if (operation === "batch") return await batch(actor, form);
    const id = candidateId.safeParse(form.get("candidate"));
    const revision = z.coerce.number().int().positive().safeParse(form.get("revision"));
    if (!id.success || !revision.success) return { error: "Select the current candidate." };
    const candidate = id.data;
    const current = revision.data;
    const href = path + "/" + candidate;
    if (operation === "evidence" || operation === "edit") {
      const value = form.get(operation === "edit" ? "product" : "evidence");
      if (typeof value !== "string" || value.length > 120_000) return { error: "Keep the draft or evidence record below 120 KB." };
      let parsed: unknown;
      try { parsed = JSON.parse(value); }
      catch { return { error: "The record must be valid JSON." }; }
      if (operation === "edit") await amendCandidate(actor, candidate, current, { draft: parsed });
      else await amendCandidate(actor, candidate, current, { evidence: parsed, resolution: String(form.get("resolution") ?? "") });
      return operation === "edit" ? { success: "Proposed edits saved.", href } : { success: "Evidence saved. Review the updated candidate version." };
    }
    const parsed = decision.safeParse(form.get("action"));
    if (operation !== "decision" || !parsed.success) return { error: "Select a valid review action." };
    const action = parsed.data;
    if (action === "approve" || action === "reject" || action === "refresh" || action === "transfer" || action === "publish") {
      const scope = action === "approve" ? marketId.array().min(1).max(2).safeParse(String(form.get("scope") ?? "").split(",")) : null;
      if (scope && !scope.success) return { error: "Review the eligible markets first." };
      await reviewCandidate(actor, candidate, current, action, String(form.get("reason") ?? ""), scope?.data);
    } else {
      const market = marketId.safeParse(form.get("market"));
      if (!market.success) return { error: "Choose the market for this draft." };
      if (action === "staff-launch") await saveLaunch(actor, candidate, current, market.data);
      else {
        const intent = action.endsWith("listing") ? "listing" : "launch";
        if (action.startsWith("queue")) {
          const task = await queueMerchandising(actor, candidate, current, intent, market.data);
          return { href: href + `?market=${market.data}&intent=${intent}&task=${task.id}` };
        }
        await applyMerchandising(actor, candidate, current, intent, market.data, String(form.get("task") ?? ""));
      }
    }
    return { href };
  } catch (error) {
    if (error instanceof OperationError) return { error: error.message };
    reportFailure("staff.merchandising", undefined, error);
    return { error: "The change could not be saved. Reload before retrying." };
  }
}
