import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assertPlanCompatibleWithContext, EditContextSchema, EditPlanSchema, type EditPlan } from "./schema";

const validPlan = loadJson<EditPlan>("llm-harness/fixtures/edit-plan.example.json");
const validContext = EditContextSchema.parse(loadJson("llm-harness/fixtures/context.example.json"));

test("accepts the checked-in example edit plan", () => {
  assert.doesNotThrow(() => EditPlanSchema.parse(validPlan));
});

test("rejects unknown human-facing fields", () => {
  const plan = clone(validPlan) as EditPlan & { notes: string[] };
  plan.notes = ["make this more dynamic"];

  assert.throws(() => EditPlanSchema.parse(plan));
});

test("rejects missing asset references", () => {
  const plan = clone(validPlan);
  plan.tracks.video[0].items[0].assetId = "missing_asset";

  assert.throws(() => EditPlanSchema.parse(plan));
});

test("rejects overlapping items on the same track", () => {
  const plan = clone(validPlan);
  plan.tracks.video[1].items[1].timelineInSec = 7.2;
  plan.tracks.video[1].items[1].timelineOutSec = 10.8;

  assert.throws(() => EditPlanSchema.parse(plan));
});

test("rejects malformed caption token timing", () => {
  const plan = clone(validPlan);
  plan.tracks.captions[0].items[0].tokens[1].timelineInSec = 0.5;

  assert.throws(() => EditPlanSchema.parse(plan));
});

test("rejects plan assets that do not match the input context", () => {
  const plan = EditPlanSchema.parse(clone(validPlan));
  plan.assets[0].uri = "raw/hallucinated-file.mp4";

  assert.throws(() => assertPlanCompatibleWithContext(plan, validContext));
});

function loadJson<T = unknown>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
