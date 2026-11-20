import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseProductOption, readProductChoice, writeProductChoice, type ChoiceAxis } from "../src/lib/catalog/product-choice.ts";

function axis(id: string, label: string, entries: [string, string][]): ChoiceAxis {
  return { id, key: label.toLowerCase(), label, values: entries.map(([id, value]) => ({ id, value, label: value })) };
}

const axes = [
  axis("model", "Phone model", [["phone-a", "Phone A"], ["phone-b", "Phone B"]]),
  axis("design", "Design", [["plain", "Plain"], ["floral", "Floral"]]),
  axis("colour", "Colour", [["blue", "Blue"], ["black", "Black"]]),
];
const variants = [
  ["v-phone-a-plain", ["phone-a", "plain", "blue"]],
  ["v-phone-a-floral", ["phone-a", "floral", "blue"]],
  ["v-phone-b-floral", ["phone-b", "floral", "black"]],
].map(([id, values]) => ({ id: id as string,
  options: (values as string[]).map((valueId, index) => ({ valueId, optionId: axes[index].id })) }));

test("an exact variant link restores only that tuple and invalid links never use a fallback", () => {
  const requested = readProductChoice(axes, variants, new URLSearchParams("variant=v-phone-b-floral&option=colour:blue"));
  assert.equal(requested.selected?.id, "v-phone-b-floral");
  assert.deepEqual(requested.picks, { model: "phone-b", design: "floral", colour: "black" });
  for (const [query, issue] of [
    ["variant=v-archived&option=colour:blue", "unavailable"],
    ["variant=invalid", "invalid"],
    ["variant=v-phone-a-plain&variant=v-phone-b-floral", "invalid"],
  ]) {
    const result = readProductChoice(axes, variants, new URLSearchParams(query));
    assert.equal(result.selected, undefined);
    assert.deepEqual(result.picks, {});
    assert.equal(result.issue, issue);
  }
});

test("partial category picks survive until a shopper completes an existing tuple", () => {
  const input = new URLSearchParams("market=us&category=cases&option=model:phone-a&option=colour:blue");
  const partial = readProductChoice(axes, variants, input);
  assert.equal(partial.selected, undefined);
  assert.deepEqual(partial.picks, { model: "phone-a", colour: "blue" });
  const next = chooseProductOption(axes, variants, partial.picks, "design", "plain");
  assert.equal(next?.selected?.id, "v-phone-a-plain");
  const restored = writeProductChoice(input, axes, next!.picks, next?.selected?.id);
  assert.equal(restored.toString(), "market=us&category=cases&variant=v-phone-a-plain");
  assert.equal(readProductChoice(axes, variants, restored).selected?.id, "v-phone-a-plain");
});

test("a model change clears incompatible dimensions without silently selecting replacement values", () => {
  const input = new URLSearchParams("variant=v-phone-a-plain&market=bd");
  const exact = readProductChoice(axes, variants, input);
  const next = chooseProductOption(axes, variants, exact.picks, "model", "phone-b");
  assert.deepEqual(next, { picks: { model: "phone-b" }, selected: undefined, cleared: ["Design", "Colour"] });
  const reset = writeProductChoice(input, axes, next!.picks);
  assert.equal(reset.toString(), "market=bd&option=model%3Aphone-b");
  const impossible = readProductChoice(axes, variants, new URLSearchParams("option=model:phone-b&option=colour:blue"));
  assert.equal(impossible.issue, "invalid-options");
  assert.equal(impossible.selected, undefined);
});

test("an optionless product resolves its sole physical SKU while a variable product waits for choices", () => {
  const blank = new URLSearchParams();
  assert.equal(readProductChoice(axes, variants, blank).selected, undefined);
  assert.equal(readProductChoice([], [{ id: "v-single", options: [] }], blank).selected?.id, "v-single");
  assert.equal(readProductChoice([], [{ id: "v-single", options: [] }, { id: "v-double", options: [] }], blank).selected, undefined);
});
