import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const installer = readFileSync(new URL("../deploy/install-marketplace.sh", import.meta.url), "utf8");
const expression = installer.match(/^marketplace_methods='\s*~(\^.*\$) 0;'$/m)?.[1];
assert.ok(expression, "The installer must supply the exact development edge write pattern");
const allows = new RegExp(expression);

test("the protected development edge admits the supported storefront and staff actions", () => {
  for (const path of [
    "/marketplace/api/newsletter",
    "/marketplace/api/notifications",
    "/marketplace/api/staff/catalog/feed-export",
    "/marketplace/api/marketplace/seller/listings",
    "/marketplace/api/checkout",
    "/marketplace/api/shopper-auth/change-password",
    "/marketplace/staff/notifications",
  ]) {
    assert.equal(allows.test("POST:" + path), true, path);
  }
});

test("edge write additions preserve exact paths and keep internal and unrelated routes closed", () => {
  for (const methodAndPath of [
    "POST:/marketplace/api/internal",
    "POST:/marketplace/api/internal/seller-finance",
    "POST:/marketplace/api/newsletter/send",
    "POST:/marketplace/api/notifications/send",
    "POST:/marketplace/api/staff/catalog/feed-export/submit",
    "POST:/marketplace/api/marketplace/seller/listings/any-child",
    "POST:/marketplace/api/marketplace/seller/finance",
    "POST:/marketplace/api/mobile/v1/customer/orders",
    "POST:/api/newsletter",
    "DELETE:/marketplace/api/notifications",
  ]) {
    assert.equal(allows.test(methodAndPath), false, methodAndPath);
  }
});

test("an update records the matching running development image and actual rollback mode", () => {
  const capture = installer.match(/^previous_marketplace_mode\(\) \{[\s\S]+?^}/m)?.[0];
  assert.ok(capture, "Expected a rollback-mode preflight");
  function invoke(image: string, mode: string, container = "abc123def456") {
    return spawnSync("bash", ["-c", `
      ${capture}
      export MOCK_IMAGE="$1" MOCK_MODE="$2" MOCK_CONTAINER="$3"
      docker() {
        if [[ "$1" == ps ]]; then printf '%s' "$MOCK_CONTAINER"; return; fi
        if [[ "$3" == '{{.Config.Image}}' ]]; then printf '%s' "$MOCK_IMAGE"; return; fi
        printf '%s' "$MOCK_MODE"
      }
      previous_marketplace_mode griipbuddy-marketplace-dev:known-previous
    `, "fixture", image, mode, container], { encoding: "utf8" });
  }
  for (const mode of ["0", "1"]) {
    const result = invoke("griipbuddy-marketplace-dev:known-previous", "GRIIP_FIRST_PARTY_STOREFRONT=" + mode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), mode);
  }
  assert.equal(invoke("griipbuddy-marketplace-dev:other", "GRIIP_FIRST_PARTY_STOREFRONT=0").status, 1);
  assert.equal(invoke("griipbuddy-marketplace-dev:known-previous", "").status, 1);
  assert.equal(invoke("griipbuddy-marketplace-dev:known-previous", "GRIIP_FIRST_PARTY_STOREFRONT=1", "missing").status, 1);
});
