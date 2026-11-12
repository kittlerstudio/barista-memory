// What the kiosk says about a coffee the moment it ends, from the api/live
// samples alone. The archived shot replaces these figures once ingest has it
// (stable weight, the shot's own duration); until then they are preliminary.
// Pure, no imports: `npm test` runs it under Node as well as in the page.

/** When the run started, in ms: the machine's elapsed time on the first sample. */
export function runStart(samples) {
  const first = samples[0];
  if (!first) return null;
  return first.t - (first.process?.elapsedMs ?? 0);
}

/** Mirror LIVE_MIN_WEIGHT_G and LIVE_WEIGHT_HEADROOM in charts.js. */
const MIN_WEIGHT_BOUND_G = 50;
const WEIGHT_HEADROOM = 1.25;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * `samples` as watchLive's onRun delivers them, `doseG` the dose in force.
 * Pressure and temperature count only while the process is active: after the
 * extraction the sensor reads the boiler climbing towards the OPV, not the
 * puck. Weight runs to the end — the cup still fills.
 */
export function runSummary(samples, doseG = null) {
  const start = runStart(samples);
  if (start == null) return null;
  const active = samples.filter((s) => s.process?.active === true);
  const lastActive = active.at(-1) ?? samples.at(-1);
  const seconds = lastActive.process?.elapsedMs != null
    ? lastActive.process.elapsedMs / 1000
    : (lastActive.t - start) / 1000;
  // A negative reading is the scale before its tare; one far past the target
  // is the cup or the spike the Bluetooth scale often ends a shot with. The
  // same bound as the live chart's weight axis.
  const target = samples.at(-1).profile?.targetWeight ?? 0;
  const maxWeight = Math.max(MIN_WEIGHT_BOUND_G, target * WEIGHT_HEADROOM);
  const weight = samples.findLast((s) => s.weight != null && s.weight >= 0 && s.weight <= maxWeight)?.weight ?? null;
  const pressures = active.map((s) => s.pressure?.current).filter((v) => v != null);
  const temps = active.map((s) => s.temperature?.current).filter((v) => v != null);
  return {
    startedAt: Math.round(start / 1000),
    endedAt: samples.at(-1).t,
    seconds,
    weight,
    ratio: weight != null && weight > 0 && doseG > 0 ? weight / doseG : null,
    maxPressure: pressures.length ? Math.max(...pressures) : null,
    meanPressure: mean(pressures),
    meanTemp: mean(temps),
  };
}
