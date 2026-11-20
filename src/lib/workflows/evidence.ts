import { getDb, type DbReader } from "../db/client.ts";
import { draftDay, draftEvidenceInput } from "../intelligence/drafts.ts";
import { canUseMarket } from "../staff/market-access.ts";

export async function intelligenceWorkflowEvidence({ db = getDb(), actorId, draftId }: { db?: DbReader; actorId: string; draftId: string }) {
  if (!/^[a-f0-9]{64}$/.test(draftId)) return null;
  const record = await db.intelligenceDraft.findUnique({ where: { id: draftId } });
  if (!record || !await canUseMarket(actorId, record.marketId, "reporting", db)) return null;
  const parsed = draftEvidenceInput.safeParse(record.evidence);
  if (!parsed.success || parsed.data.marketId !== record.marketId || parsed.data.test !== record.test ||
      parsed.data.from !== draftDay(record.from) || parsed.data.to !== draftDay(record.through)) return null;
  return { ...parsed.data, kind: record.kind, draftId, createdAt: record.createdAt,
    evidenceRef: { kind: "intelligence-draft", ref: draftId, from: parsed.data.from, to: parsed.data.to } };
}
