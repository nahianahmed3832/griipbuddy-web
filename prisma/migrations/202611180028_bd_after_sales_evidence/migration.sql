ALTER TABLE "OrderCase"
  DROP CONSTRAINT "OrderCase_refund_complete",
  DROP CONSTRAINT "OrderCase_return_receipt_fields",
  ADD CONSTRAINT "OrderCase_refund_complete" CHECK (
    ("refundAmountMinor" IS NULL AND "refundMethod" IS NULL AND "refundReference" IS NULL AND "refundConfirmedAt" IS NULL
      AND "status" NOT IN ('REFUND_APPROVED', 'REFUND_FAILED'))
    OR ("refundAmountMinor" IS NOT NULL AND "refundAmountMinor" > 0 AND
      (("status" IN ('REFUND_APPROVED', 'REFUND_FAILED') AND "refundMethod" IS NULL
        AND "refundReference" IS NULL AND "refundConfirmedAt" IS NULL)
      OR ("status" NOT IN ('REFUND_APPROVED', 'REFUND_FAILED') AND "refundMethod" IS NOT NULL
        AND "refundReference" IS NOT NULL AND "refundConfirmedAt" IS NOT NULL)))
  ),
  ADD CONSTRAINT "OrderCase_return_receipt_fields" CHECK (
    ("returnReceivedAt" IS NULL AND "returnReceivedById" IS NULL AND "returnDisposition" IS NULL)
    OR ("kind" IN ('RETURN', 'EXCHANGE') AND "returnReceivedAt" IS NOT NULL AND "returnDisposition" IS NOT NULL)
  ),
  ADD CONSTRAINT "OrderCase_exchange_dispatch_fields" CHECK (
    ("replacementCarrier" IS NULL AND "replacementTrackingReference" IS NULL)
    OR ("kind" = 'EXCHANGE' AND "returnReceivedAt" IS NOT NULL AND
      "replacementCarrier" IS NOT NULL AND "replacementTrackingReference" IS NOT NULL)
  );

ALTER TABLE "OrderCaseReturnLine"
  ADD CONSTRAINT "OrderCaseReturnLine_replacement_fields" CHECK (
    num_nonnulls("replacementVariantId", "replacementVariantName") IN (0, 2)
  );
