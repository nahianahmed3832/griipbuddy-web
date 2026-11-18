import { revalidatePath } from "next/cache";
import { z } from "zod";
import { privateHeaders, readBody, readJson, sameOrigin } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { currentMarket, storefrontMarketAllowed } from "@/lib/market-server";
import type { AccountLanguage } from "@/lib/marketplace/account-language";
import { getShopper } from "@/lib/marketplace/auth";
import { caseErrorLabel } from "@/lib/marketplace/case-language";
import { caseActorRole, caseCommand } from "@/lib/marketplace/case-policy";
import { buyerCasePhoto, executeOrderCase, OrderCaseError, staffCasePhoto } from "@/lib/marketplace/cases";
import { marketplaceMode } from "@/lib/release-config";
import { getStaff } from "@/lib/staff/access";
import { encodeCatalogImage, uploadLimit } from "@/lib/staff/catalog-media";
import { OperationError } from "@/lib/staff/operations";

const privateFailure = () => new Response(null, { status: 404, headers: privateHeaders });
const badDetails = "Check the case details and try again.";

function reject(message: string, status: number, language: AccountLanguage = "en") {
  return Response.json({ message: caseErrorLabel(language, message) }, { status, headers: privateHeaders });
}

function refreshInventory() {
  revalidatePath("/staff/catalog/inventory");
  revalidatePath("/", "layout");
}

async function readCaseRequest(request: Request): Promise<{ payload: unknown; photo?: File }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data;")) return { payload: await readJson(request, 8192) };
  const body = await readBody(request, uploadLimit + 12_288);
  if (!body) return { payload: null };
  try {
    const fields = await new Response(new Uint8Array(body), { headers: { "Content-Type": contentType } }).formData();
    const payload = fields.get("payload");
    const photo = fields.get("photo");
    if (typeof payload !== "string" || payload.length > 8192 || !(photo instanceof File) || photo.size < 1 || photo.size > uploadLimit ||
      fields.getAll("payload").length !== 1 || fields.getAll("photo").length !== 1) return { payload: null };
    return { payload: JSON.parse(payload) as unknown, photo };
  } catch {
    return { payload: null };
  }
}

export async function GET(request: Request) {
  if (!marketplaceMode()) return privateFailure();
  const query = new URL(request.url).searchParams;
  const caseId = z.uuid().safeParse(query.get("photo"));
  const market = query.get("market");
  if (!caseId.success || !storefrontMarketAllowed(market)) return privateFailure();
  const staffView = query.get("staff") === "1";
  const viewer = staffView ? await getStaff() : await getShopper();
  if (!viewer) return privateFailure();
  try {
    const attachment = staffView ? await staffCasePhoto(viewer.id, caseId.data, market) : await buyerCasePhoto(viewer.id, caseId.data, market);
    if (!attachment) return privateFailure();
    return new Response(new Uint8Array(attachment.data), { headers: {
      ...privateHeaders, "Content-Type": "image/webp", "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin", "Content-Disposition": 'attachment; filename="order-case-photo.webp"',
    } });
  } catch (error) {
    if (!(error instanceof OperationError)) reportFailure("marketplace.cases.photo", undefined, error);
    return privateFailure();
  }
}

export async function POST(request: Request) {
  if (!marketplaceMode()) return privateFailure();
  const query = new URL(request.url).searchParams;
  const requestedMarket = query.get("market");
  const language: AccountLanguage = requestedMarket === "bd" && query.get("lang") === "bn" ? "bn" : "en";
  if (!sameOrigin(request)) return reject("Open this action from the storefront.", 403, language);
  if (requestedMarket !== null && !storefrontMarketAllowed(requestedMarket)) return reject(badDetails, 400, language);
  const { payload, photo } = await readCaseRequest(request);
  const input = caseCommand.safeParse(payload);
  if (!input.success || (photo && input.data.action !== "open")) return reject(badDetails, 400, language);

  try {
    const command = input.data;
    if (caseActorRole(command.action) === "owner") {
      const staff = await getStaff();
      if (!staff) return reject("Sign in as staff to continue.", 401);
      if (staff.role !== "OWNER") return reject("You don’t have permission for that action.", 403);
      if (!await consumeQuota("marketplace.cases.owner", staff.id, 90, 300)) return reject("Too many actions. Try again shortly.", 429);
      const data = await executeOrderCase({ id: staff.id, role: "owner", market: requestedMarket ?? undefined }, command);
      if (command.action === "approve-cancellation" || command.action === "ship-exchange" ||
        command.action === "receive" && command.disposition === "RESTOCK") refreshInventory();
      return Response.json({ data }, { headers: privateHeaders });
    }

    const shopper = await getShopper();
    if (!shopper) return reject("Sign in to continue.", 401, language);
    const opening = command.action === "open";
    const quotaKey = opening ? "marketplace.cases.open" : "marketplace.cases.update";
    if (!await consumeQuota(quotaKey, shopper.id, opening ? 8 : 30, 3600)) {
      return reject("Too many actions. Try again shortly.", 429, language);
    }
    const market = requestedMarket ?? (await currentMarket()).id;
    const image = photo ? (await encodeCatalogImage(Buffer.from(await photo.arrayBuffer()), photo.type)).data : undefined;
    const data = await executeOrderCase({ id: shopper.id, role: "shopper", market }, command, image);
    if (command.action === "open" && command.kind === "CANCEL" && market === "bd") refreshInventory();
    return Response.json({ data }, { status: opening ? 201 : 200, headers: privateHeaders });
  } catch (error) {
    if (error instanceof OrderCaseError) return reject(error.message, error.status, language);
    if (error instanceof OperationError) return reject(error.message, photo ? 422 : 403, language);
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
      return reject("This case changed while you were working. Refresh the page and try again.", 409, language);
    }
    reportFailure("marketplace.cases.write", undefined, error);
    return reject("We couldn't save this change. Try again.", 503, language);
  }
}
