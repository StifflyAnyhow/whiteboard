import assert from "node:assert/strict";
import test from "node:test";
import { confirmReviewDeletion } from "./reviewDeleteConfirmation.js";

test("a canvas closed during confirmation cannot delete", async () => {
  const pending = Promise.withResolvers<boolean>();
  let current = true;
  const result = confirmReviewDeletion(() => pending.promise, "Original session", () => current);
  current = false;
  pending.resolve(true);
  assert.equal(await result, false);
});

test("moving to Trash asks only when other boards need the board", async () => {
  const asked: boolean[] = [];
  const ask = async (_title: string, _named: unknown, trash?: boolean) => {
    asked.push(trash ?? false);
    return false;
  };
  assert.equal(await confirmReviewDeletion(ask, "Alone", () => true, { linkedFrom: [] }, true), true);
  assert.deepEqual(asked, []);
  assert.equal(await confirmReviewDeletion(ask, "Linked", () => true, { linkedFrom: [{ title: "Notes" }] }, true), false);
  assert.deepEqual(asked, [true]);
});

test("several boards are asked about once, with their count", async () => {
  const counts: (number | undefined)[] = [];
  const ask = async (_title: string, _named: unknown, _trash?: boolean, count?: number) => {
    counts.push(count);
    return true;
  };
  assert.equal(await confirmReviewDeletion(ask, "3 whiteboards", () => true, { linkedFrom: [{ title: "Notes" }] }, true, 3), true);
  assert.deepEqual(counts, [3]);
});
