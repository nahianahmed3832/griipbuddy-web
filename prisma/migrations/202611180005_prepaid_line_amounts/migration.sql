BEGIN;

ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_totals_check";
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_totals_check" CHECK (
  "quantity" BETWEEN 1 AND 99 AND "unitPriceMinor" > 0
  AND "unitDiscountMinor" >= 0 AND "unitDiscountMinor" < "unitPriceMinor"
  AND "couponDiscountMinor" >= 0 AND "prepaidDiscountMinor" >= 0 AND "lineTotalMinor" >= 0
  AND "lineTotalMinor" = ("unitPriceMinor"::bigint - "unitDiscountMinor") * "quantity" - "couponDiscountMinor" - "prepaidDiscountMinor"
);

ALTER TABLE "Order" ADD CONSTRAINT "Order_prepaid_totals_check" CHECK (
  "prepaidDiscountMinor" BETWEEN 0 AND "discountMinor" - "couponDiscountMinor"
);

COMMIT;
