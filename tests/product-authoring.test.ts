import assert from "node:assert/strict";
import test from "node:test";
import { draftProduct, normalizeVariantDraft, proposalCombinations, variantTuple, type DraftOption } from "../src/components/connected-product-draft.ts";
import { variantOptionSignature } from "../src/lib/catalog/option-signature.ts";

const model: DraftOption = { id: "model", key: "model", label: "Model", values: [
  { id: "phone-a", value: "phone-a", label: "Phone A" }, { id: "phone-b", value: "phone-b", label: "Phone B" },
] };
const design: DraftOption = { id: "design", key: "design", label: "Design", values: [
  { id: "plain", value: "plain", label: "Plain" }, { id: "wave", value: "wave", label: "Wave" },
] };
const stored = { id: "v-phone-a-wave", sku: "PHONE-A-WAVE", active: true, selections: { model: "phone-a", design: "wave" }, attributeValues: {} };

test("combination preview leaves issued rows as-is when display values and order change", () => {
  const proposals = proposalCombinations([model, design], [stored]);
  assert.equal(proposals?.length, 3);
  assert.ok(proposals?.some(candidate => candidate.model === "phone-b" && candidate.design === "plain"));
  assert.ok(!proposals?.some(candidate => variantOptionSignature(candidate) === variantOptionSignature(stored.selections)));
  const renamed = { ...model, values: [...model.values].reverse().map(value => ({ ...value, label: `New ${value.label}` })) };
  assert.equal(variantTuple([design, renamed], stored.selections), "Wave / New Phone A");
  assert.deepEqual(
    proposalCombinations([design, renamed], [stored])?.map(variantOptionSignature).sort(),
    proposals?.map(variantOptionSignature).sort(),
  );
  assert.equal(stored.sku, "PHONE-A-WAVE");
});

test("large option spaces stay bounded and one active simple row becomes the default", () => {
  const large = Array.from({ length: 8 }, (_, index) => ({ ...model, id: `axis-${index}` }));
  assert.equal(proposalCombinations(large, []), null);
  assert.deepEqual(proposalCombinations([], []), [{}]);
  const standard = { ...stored, id: "v-simple", sku: "STANDARD", selections: {} };
  const created = normalizeVariantDraft(draftProduct(null), [standard]);
  assert.equal(created.defaultVariantId, "v-simple");
  assert.equal(normalizeVariantDraft(created, [{ ...standard, active: false }]).defaultVariantId, "");
});
