import { test } from "node:test";
import assert from "node:assert/strict";
import { runStart, runSummary } from "./runSummary.js";

const T0 = 1_763_000_000_000;

/** 30 active samples, 1 s apart: pressure 2 → 9 bar, weight 0 → 36 g, 93 °C; then the boiler climb. */
function shot() {
  const samples = [];
  for (let i = 0; i < 30; i++) {
    samples.push({
      t: T0 + 2000 + i * 1000,
      process: { active: true, phase: "Extraction", elapsedMs: 2000 + i * 1000 },
      pressure: { current: 2 + (7 * i) / 29 },
      temperature: { current: 93 },
      weight: (36 * i) / 29,
    });
  }
  for (let i = 0; i < 3; i++) {
    samples.push({
      t: T0 + 32_000 + i * 500,
      process: { active: false, phase: "Finished", elapsedMs: null },
      pressure: { current: 9.8 },
      temperature: { current: 92.5 },
      weight: 36,
    });
  }
  return samples;
}

test("runStart takes the machine's elapsed time off the first sample", () => {
  assert.equal(runStart(shot()), T0);
  assert.equal(runStart([]), null);
});

test("the boiler climb after the extraction is not the shot's pressure", () => {
  const s = runSummary(shot(), 18);
  assert.equal(s.maxPressure, 9);
  assert.equal(s.weight, 36);
  assert.equal(s.ratio, 2);
  assert.equal(s.meanTemp, 93);
  assert.equal(s.seconds, 31);
  assert.equal(s.startedAt, Math.round(T0 / 1000));
});

test("a scale spike at the end is not the yield", () => {
  const samples = shot();
  samples.at(-1).weight = 58_000;
  assert.equal(runSummary(samples, 18).weight, 36);
});

test("no dose, no ratio; an untared scale is not coffee", () => {
  const samples = shot().map((x) => ({ ...x, weight: -3 }));
  const s = runSummary(samples, null);
  assert.equal(s.weight, null);
  assert.equal(s.ratio, null);
  assert.equal(runSummary([], 18), null);
});
