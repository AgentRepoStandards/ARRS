import { strict as assert } from "node:assert";
import { test } from "node:test";
import { previewTask } from "./src/domain/task.mjs";
test("task title is normalized and queued", () =>
  assert.deepEqual(previewTask(" Inspect drift "), {
    title: "Inspect drift",
    state: "queued",
  }));
test("empty titles are refused", () =>
  assert.throws(() => previewTask("  "), /required/));
