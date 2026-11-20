import { z } from "zod";
import { uuid } from "../commerce/checkout-types.ts";
import { couponCodeInput } from "./coupon-input.ts";

const text = (limit: number) => z.string().trim().min(1).max(limit).refine(value => !value.includes("\0"));
const title = text(120);
const body = text(4000);
const operation = { operationId: uuid };
const seller = { ...operation, shopId: uuid };
const decision = z.enum(["ACCEPTED", "DECLINED"]);
const simple = z.object({ ...operation, action: z.literal("notice.publish"), title, body,
  scope: z.enum(["PLATFORM", "MARKET"]) }).strict();
const targeted = z.object({ ...operation, action: z.literal("notice.publish"), title, body,
  scope: z.literal("SHOP"), shopId: uuid }).strict();

export const adminHubInput = z.union([
  simple, targeted,
  z.object({ ...operation, action: z.literal("campaign.invite"), shopId: uuid, title, body, reference: couponCodeInput }).strict(),
  z.object({ ...operation, action: z.literal("request.review"), id: uuid, decision, note: body }).strict(),
  z.object({ ...operation, action: z.literal("conversation.start"), shopId: uuid, title, text: body }).strict(),
  z.object({ ...operation, action: z.literal("conversation.reply"), id: uuid, text: body }).strict(),
]);

export const sellerHubInput = z.discriminatedUnion("action", [
  z.object({ ...seller, action: z.literal("notice.acknowledge"), id: uuid }).strict(),
  z.object({ ...seller, action: z.literal("record.read"), id: uuid }).strict(),
  z.object({ ...seller, action: z.literal("request.submit"), title, body, category: z.enum(["CATEGORY", "BRAND", "OTHER"]) }).strict(),
  z.object({ ...seller, action: z.literal("campaign.respond"), id: uuid, decision }).strict(),
  z.object({ ...seller, action: z.literal("conversation.start"), title, text: body }).strict(),
  z.object({ ...seller, action: z.literal("conversation.reply"), id: uuid, text: body }).strict(),
]);
