import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredManualPayments } from "../src/lib/commerce/manual-payment-config.ts";

test("the shared wallet recipient is used only for enabled hybrid test payments", t => {
  const testRecipient = "01700000000";
  const values = {
    COMMERCE_MODE: "staging",
    GRIIP_MARKETPLACE_PREVIEW: "1",
    GRIIP_HYBRID_STOREFRONT: "1",
    BETTER_AUTH_URL: "https://dev.griipbuddy.com",
    DATABASE_URL: "postgresql://griipbuddy_demo:fixture@db/griipbuddy_hybrid_demo",
    BD_MANUAL_TEST_MODE: "1",
    BD_MANUAL_TEST_RECIPIENT: testRecipient,
    BD_MANUAL_BKASH_NUMBER: "01900000000",
    BD_MANUAL_NAGAD_NUMBER: "",
    BD_MANUAL_ROCKET_NUMBER: "",
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, values);
  assert.deepEqual(configuredManualPayments(), [
    { method: "BKASH", recipient: testRecipient, test: true },
    { method: "NAGAD", recipient: testRecipient, test: true },
    { method: "ROCKET", recipient: testRecipient, test: true },
  ]);

  const examples = ["01XXXXXXXXX", "01XXXXXXXXX", "01XXXXXXXXXX"];
  process.env.BD_MANUAL_TEST_RECIPIENT = "12345";
  assert.deepEqual(configuredManualPayments().map(payment => payment.recipient), examples);
  process.env.BD_MANUAL_TEST_RECIPIENT = testRecipient;
  process.env.GRIIP_HYBRID_STOREFRONT = "0";
  assert.deepEqual(configuredManualPayments().map(payment => payment.recipient), examples);
  process.env.BD_MANUAL_TEST_MODE = "0";
  assert.deepEqual(configuredManualPayments(), []);

  process.env.COMMERCE_MODE = "production";
  assert.deepEqual(configuredManualPayments(), [{ method: "BKASH", recipient: values.BD_MANUAL_BKASH_NUMBER, test: false }]);
});
