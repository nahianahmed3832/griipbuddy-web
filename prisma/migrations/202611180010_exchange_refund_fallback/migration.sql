ALTER TABLE "OrderCase"
  DROP CONSTRAINT "OrderCase_refund_amount",
  ADD CONSTRAINT "OrderCase_refund_amount" CHECK (
    "refundAmountMinor" IS NULL OR (
      "refundAmountMinor" > 0 AND (
        "kind" IN ('RETURN', 'CANCEL')
        OR ("kind" = 'EXCHANGE' AND "returnReceivedAt" IS NOT NULL AND "replacementTrackingReference" IS NULL)
      )
    )
  );
