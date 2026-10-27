// DO NOT MERGE: deliberate failure proving that the CI gate fails.
import test from "node:test";
import assert from "node:assert/strict";

test("CI red proof", () => {
  assert.equal(1 + 1, 3);
});
