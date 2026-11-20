import { after } from "next/server";
import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { reportFailure, type requestId } from "../db/observability.ts";
import {
  cookieId, hasStaffMeasurementSession, linkAcceptedOrder, linkCheckoutAttempt, measurementEnabled, measurementSessionHeader,
} from "./server.ts";

export function measureCheckout(request: Request, token: string | undefined, input: {
  marketId: MarketId; guestKey: string; reference: ReturnType<typeof requestId>; attemptId?: string; orderId?: string;
}) {
  if (!measurementEnabled() || !token || request.headers.get("sec-gpc") === "1" || hasStaffMeasurementSession(request.headers)) return;
  const sessionId = z.uuidv4().safeParse(request.headers.get(measurementSessionHeader)).data;
  const { marketId, guestKey, reference, attemptId, orderId } = input;
  if (!(attemptId && sessionId) && !orderId) return;
  // The response comes from the commerce authority. Consent, attribution, or
  // analytics database errors cannot turn a committed purchase into a failure.
  const report = (error: unknown) => reportFailure("measurement.checkout-match", reference, error);
  const link = async () => {
    const journeyId = cookieId(token);
    if (!journeyId) return;
    if (attemptId && sessionId) await linkCheckoutAttempt(attemptId, guestKey, journeyId, marketId, sessionId);
    if (orderId) await linkAcceptedOrder(orderId, guestKey, journeyId, sessionId);
  };
  try { after(() => link().catch(report)); }
  catch (error) { report(error); }
}
