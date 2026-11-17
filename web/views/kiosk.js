import { t, tn } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { fmt, toast } from "../lib/fmt.js";
import { usage, tone } from "../lib/maintenance.js";
import { watchLive } from "../lib/live.js";
import { liveChart } from "../lib/charts.js";
import { runStart, runSummary } from "../lib/runSummary.js";

/**
 * The kiosk: a fixed 800×480 touch display next to the machine. Screens sit
 * side by side and are switched by a swipe this page handles itself — touch
 * scrolling in WPE (the kiosk's browser) is unreliable and turns many drags
 * into taps, so nothing here scrolls and a drag never reaches a button.
 *
 * The screens come from the archive (api/kiosk). A coffee being pulled comes
 * from api/live — the server's one shared socket to the machine, never the
 * machine itself — and takes the whole display over the screens until it has
 * ended and its summary has been seen.
 */

/** Grind changes are saved once the presses stop, as one setup period, not one per step. */
const GRIND_SAVE_MS = 1500;
/** How far a finger moves before a touch is a swipe and no longer a tap. */
const DRAG_PX = 12;
/** Past this share of the width, a released swipe moves to the next screen. */
const SWIPE_SHARE = 0.18;
/** Nothing on screen changes faster than a coffee is made. */
const REFRESH_MS = 60_000;
/** The run's end stays on the live screen this long before the summary slides in. */
const SUMMARY_DELAY_MS = 1500;
/** The summary stays this long after the run ended, then the kiosk goes back. */
const SUMMARY_KEEP_MS = 5 * 60_000;
/** A coffee whose stream has been silent this long is given up: the kiosk unlocks. */
const STALE_MS = 2 * 60_000;
/** How often, and for how long, the archive is asked for the shot the run became. */
const ARCHIVE_POLL_MS = 10_000;
const ARCHIVE_WAIT_MS = 3 * 60_000;
/** An archived shot that started this close to the run is the run. */
const ARCHIVE_MATCH_S = 30;
/** A weighing is steady once the scale has moved less than this over the window. */
const STEADY_G = 0.3;
const STEADY_MS = 1500;

const PLUS = `<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true"><path d="M7.5 24.5H40.5M24 8V41"/></svg>`;
const MINUS = `<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true"><path d="M7.5 24.5H40.5"/></svg>`;

/**
 * "Zbývá 298 g" and "vydrží 4 dny / 12 shotů": what the bag has left, by
 * weight, then by time and coffees. The row is the way into weighing it.
 */
function stockRow(stock, dose) {
  const known = stock.remaining_g != null;
  const lasts = [];
  if (known && stock.days_left != null) lasts.push(t("kiosk.stock.lasts", { days: tn("kiosk.stock.days", stock.days_left) }));
  if (known && dose > 0) lasts.push(tn("kiosk.stock.shots", Math.floor(stock.remaining_g / dose)));
  return `
        <button type="button" class="stock" data-calib-open>
          <span class="pill ${stock.low ? "warn" : ""}">${known ? t("kiosk.stock.left", { g: stock.remaining_g }) : t("kiosk.calib.start")}</span>
          <span>${lasts.join(" / ")}</span>
        </button>`;
}

function calibrationCard() {
  return `
    <section class="card kiosk-calib-card">
      <div class="card-head"><h2>${t("kiosk.calib.title")}</h2><span class="pill" data-calib="scale"></span></div>
      <p class="hint" data-calib="hint"></p>
      <div class="weight num"><b data-calib="weight">–</b><small>g</small></div>
      <p class="sub" data-calib="sub"></p>
      <div class="actions">
        <button type="button" class="btn" data-calib-act="cancel">${t("kiosk.calib.cancel")}</button>
        <button type="button" class="btn" data-calib-act="back" hidden>${t("kiosk.calib.back")}</button>
        <button type="button" class="btn primary" data-calib-act="next"></button>
      </div>
    </section>`;
}

function tile(key, label, unit) {
  return `<div class="kiosk-tile"><span class="v num"><b data-tile="${key}">–</b> <small>${unit}</small></span><span class="l">${label}</span></div>`;
}

/**
 * The first screen: the coffee in the grinder above the machine's state on
 * the left, the grind and its +/- on the right, where a thumb reaches it.
 */
function homeScreen(data, grind) {
  const s = data.setup;
  const coffee = s ? `
      <div class="kiosk-coffee">
        <div class="what">
          <h2>${t("now.brewing")}</h2>
          <div class="bean">${s.bean ?? "?"}</div>
          <div class="roaster">${s.roaster ?? ""}</div>
          <div class="since">${t("setup.since")} ${fmt.dateTime(s.valid_from)}</div>
        </div>
        <div class="dose">
          <h2>${t("now.dose")}</h2>
          <div class="num">${s.dose_g != null ? s.dose_g + "g" : "–"}</div>
        </div>
      </div>
      ${data.stock ? stockRow(data.stock, s.dose_g) : ""}` : `<div><h2>${t("now.brewing")}</h2><p class="muted">${t("now.no_setup")}</p></div>`;
  return `
    <div class="kiosk-left">
      <section class="card kiosk-home">${coffee}</section>
      <section class="card kiosk-machine">
        <h2>${t("kiosk.machine.title")}</h2>
        <div class="tiles">
          ${tile("boiler", t("kiosk.machine.boiler"), "%")}${tile("warm", t("kiosk.machine.warm"), "%")}${tile("pressure", t("kiosk.machine.pressure"), "bar")}
        </div>
      </section>
    </div>
    <section class="card kiosk-grind">
      <button type="button" data-grind="1" aria-label="${t("kiosk.coarser")}">${PLUS}</button>
      <span class="value num" data-grind-value>${grind ?? "–"}</span>
      <button type="button" data-grind="-1" aria-label="${t("kiosk.finer")}">${MINUS}</button>
    </section>`;
}

function dueText(m) {
  if (m.due_in_days == null) return "–";
  return m.due_in_days === 0 ? t("kiosk.due_now") : t("kiosk.due_in", { n: m.due_in_days });
}

function maintenanceCard(data) {
  const rows = data.maintenance ?? [];
  return `
    <section class="card maint-card">
      <h2>${t("maint.title")}</h2>
      ${rows.length ? rows.map((m) => `
        <div class="kiosk-maint ${tone(m)}">
          <div class="head">
            <b>${t("maint.type." + m.key)}</b>
            <span class="due ${tone(m)}">${dueText(m)}</span>
          </div>
          <div class="gauge"><i style="width:${Math.min(100, Math.round((m.fraction ?? 0) * 100))}%"></i></div>
          <div class="usage num">${usage(m)}</div>
        </div>`).join("") : `<p class="muted">${t("maint.log_empty")}</p>`}
    </section>`;
}

function liveCard() {
  const stat = (key, label, cls = "") => `<div class="stat ${cls}"><span class="v num" data-live="${key}">–</span><span class="l" data-live-label="${key}">${label}</span></div>`;
  return `
    <section class="card kiosk-live-card">
      <div class="card-head">
        <h2 data-live="title"></h2>
        <span><span class="pill bad" data-live="offline" hidden>${t("kiosk.live.connection_lost")}</span> <span class="pill accent" data-live="phase"></span></span>
      </div>
      <div class="kiosk-live-stats">
        ${stat("time", t("shot.time"), "big")}${stat("weight", t("shot.weight"), "big")}${stat("pressure", t("shot.pressure"))}${stat("flow", t("shot.flow"))}${stat("temp", t("shot.temperature"))}
      </div>
      <div class="kiosk-chart"></div>
    </section>`;
}

function summaryCard() {
  const stat = (key, label) => `<div class="stat"><span class="v num" data-sum="${key}">–</span><span class="l">${label}</span></div>`;
  return `
    <section class="card kiosk-summary-card">
      <div class="card-head"><h2>${t("kiosk.summary.title")}</h2><span class="pill" data-sum="preliminary">${t("kiosk.summary.preliminary")}</span></div>
      <div class="kiosk-summary-stats">
        ${stat("time", t("shot.time"))}${stat("weight", t("shot.weight"))}${stat("ratio", t("shot.ratio"))}
        ${stat("max_pressure", t("kiosk.summary.max_pressure"))}${stat("mean_pressure", t("kiosk.summary.mean_pressure"))}${stat("mean_temp", t("kiosk.summary.mean_temp"))}
      </div>
      <div class="kiosk-chart"></div>
    </section>`;
}

/** Applies `change` to `el` with its transition off: a jump, not a slide. */
function jump(el, change) {
  el.style.transition = "none";
  change();
  void el.offsetWidth;
  el.style.transition = "";
}

export async function renderKiosk(view) {
  const root = document.documentElement;
  root.classList.add("kiosk");
  const themeBefore = root.dataset.theme;
  root.dataset.theme = "dark";

  const [first, prefs] = await Promise.all([api.kiosk(), api.preferences().catch(() => null)]);
  const scale = { min: prefs?.grind_min ?? 0, max: prefs?.grind_max ?? 90, step: prefs?.grind_step ?? 0.5 };

  let latest = first;
  let index = 0;
  /** A grind value pressed but not saved yet; it wins over what the server says. */
  let pendingGrind = null;
  let saveTimer = null;

  view.innerHTML = `
    <div class="kiosk-frame">
      <div class="kiosk-track"><div class="kiosk-screen"></div><div class="kiosk-screen"></div></div>
      <div class="kiosk-dots"><i></i><i></i></div>
      <div class="kiosk-live"><div class="kiosk-live-track">
        <div class="kiosk-live-pane">${liveCard()}</div><div class="kiosk-live-pane">${summaryCard()}</div>
      </div></div>
      <div class="kiosk-calib">${calibrationCard()}</div>
    </div>`;
  const frame = view.querySelector(".kiosk-frame");
  const track = view.querySelector(".kiosk-track");
  const screens = [...view.querySelectorAll(".kiosk-screen")];
  const dots = [...view.querySelectorAll(".kiosk-dots i")];

  const draw = () => {
    screens[0].innerHTML = homeScreen(latest, pendingGrind ?? latest.setup?.grind_setting);
    screens[1].innerHTML = maintenanceCard(latest);
    paintTiles();
  };
  // ---- the machine's state -----------------------------------------------
  // The boiler and the pressure follow the live stream; the machine's warmth
  // is the server's thermal model, as fresh as the last api/kiosk.
  /** The latest live status; null while the stream says the machine is off. */
  let status = null;
  const paintTiles = () => {
    const cell = (key) => screens[0].querySelector(`[data-tile="${key}"]`);
    const w = latest.warmth;
    const ct = status?.temperature.current;
    const setpoint = status?.temperature.target > 0 ? status.temperature.target : w?.setpoint_c;
    let boiler = null;
    if (ct != null && w && setpoint > w.cold_baseline_c) {
      boiler = Math.round(Math.max(0, Math.min(1, (ct - w.cold_baseline_c) / (setpoint - w.cold_baseline_c))) * 100);
    }
    const pressure = status?.pressure.current;
    if (cell("boiler")) cell("boiler").textContent = boiler ?? "–";
    if (cell("warm")) cell("warm").textContent = w?.settledness ?? "–";
    if (cell("pressure")) cell("pressure").textContent = pressure != null ? Math.max(0, pressure).toFixed(1) : "–";
  };
  const place = (offsetPx = 0) => {
    track.style.transform = `translateX(calc(${-index * 100}% + ${offsetPx}px))`;
    dots.forEach((d, i) => d.classList.toggle("active", i === index));
  };
  draw(); place();

  const refresh = async () => {
    try { latest = await api.kiosk(); draw(); } catch { /* the next poll tries again */ }
  };

  // ---- grind -------------------------------------------------------------
  const saveGrind = async () => {
    saveTimer = null;
    const value = pendingGrind;
    try {
      const r = await api.recordSetup({ grind_setting: value });
      toast(t("setup.saved", { bean: r.setup.bean ?? "?", grind: r.setup.grind_setting ?? "?", dose: r.setup.dose_g ?? "?" }));
    } catch (err) {
      toast(err.message, "bad");
    }
    // A press during the save started a new wait; that value is still pending.
    if (pendingGrind === value) pendingGrind = null;
    await refresh();
  };
  const stepGrind = (dir) => {
    const current = pendingGrind ?? latest.setup?.grind_setting;
    if (current == null) return;
    const next = Math.round((Number(current) + dir * scale.step) / scale.step) * scale.step;
    pendingGrind = Math.min(scale.max, Math.max(scale.min, next));
    const el = view.querySelector("[data-grind-value]");
    if (el) el.textContent = pendingGrind;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveGrind, GRIND_SAVE_MS);
  };

  // ---- the coffee being pulled ---------------------------------------------
  // normal → live (locked) → summary → normal. The layer slides in over the
  // swipe screens, which stay where they were underneath.
  const layer = view.querySelector(".kiosk-live");
  const layerTrack = view.querySelector(".kiosk-live-track");
  const [livePane, summaryPane] = view.querySelectorAll(".kiosk-live-pane");
  const liveCell = (key) => livePane.querySelector(`[data-live="${key}"]`);
  const sumCell = (key) => summaryPane.querySelector(`[data-sum="${key}"]`);
  let mode = "normal";
  /** runStart() of the run on the layer, and of the last summary sent away. */
  let runKey = null;
  let dismissedKey = null;
  let lastSampleAt = 0;
  let summary = null;
  let liveView = null, summaryView = null;
  let summaryTimer = null, keepTimer = null, archiveTimer = null;

  // Created on first use: the layer is laid out off screen, so it has a size.
  const chartIn = (pane) => {
    const box = pane.querySelector(".kiosk-chart");
    return liveChart(box, { height: Math.max(120, box.clientHeight) });
  };
  const clearTimers = () => {
    clearTimeout(summaryTimer); clearTimeout(keepTimer); clearTimeout(archiveTimer);
    summaryTimer = keepTimer = archiveTimer = null;
  };
  /** Shows the layer on `pane` (0 live, 1 summary): a slide when it is already up. */
  const showPane = (pane) => {
    const to = pane ? "translateX(-100%)" : "";
    if (layer.classList.contains("show")) layerTrack.style.transform = to;
    else jump(layerTrack, () => (layerTrack.style.transform = to));
    layer.classList.add("show");
  };

  const enterLive = (key) => {
    clearTimers();
    // A coffee pulled mid-weighing ends the weighing: the scale is the cup's now.
    closeCalib();
    // A grind pressed just before the pull is saved now, not left under the layer.
    if (saveTimer) { clearTimeout(saveTimer); saveGrind(); }
    if (start?.dragging) { track.classList.remove("dragging"); place(); }
    start = null;
    mode = "live";
    runKey = key;
    showPane(0);
  };

  const paintLive = (samples) => {
    const first = samples[0], last = samples.at(-1);
    const active = last.process?.active === true;
    liveView ??= chartIn(livePane);
    liveView.update(samples);
    liveCell("title").textContent = t(active ? "live.brewing" : "live.finished");
    const phase = last.process?.phase;
    liveCell("phase").textContent = phase ?? "";
    liveCell("phase").hidden = !phase;
    liveCell("time").textContent = fmt.seconds((last.t - first.t + (first.process?.elapsedMs ?? 0)) / 1000);
    liveCell("weight").textContent = fmt.g(last.weight);
    const target = last.profile?.targetWeight;
    livePane.querySelector('[data-live-label="weight"]').textContent = t("shot.weight") + (target ? ` / ${target} g` : "");
    // After the run the sensor reads the boiler; the last pressure of the run stays.
    liveCell("pressure").textContent = fmt.bar(samples.findLast((s) => s.process?.active)?.pressure.current);
    const flow = last.flow.puck ?? last.flow.pump;
    liveCell("flow").textContent = flow == null ? "–" : `${flow.toFixed(1)} ml/s`;
    liveCell("temp").textContent = fmt.temp(last.temperature.current);
  };

  const paintSummary = () => {
    sumCell("time").textContent = fmt.seconds(summary.seconds);
    sumCell("weight").textContent = fmt.g(summary.weight);
    sumCell("ratio").textContent = fmt.ratio(summary.ratio);
    sumCell("max_pressure").textContent = fmt.bar(summary.maxPressure);
    sumCell("mean_pressure").textContent = fmt.bar(summary.meanPressure);
    sumCell("mean_temp").textContent = fmt.temp(summary.meanTemp);
    sumCell("preliminary").hidden = summary.archived;
  };

  // The live figures are the scale's raw reading; once ingest has the shot,
  // its stable weight, ratio and duration replace them.
  const pollArchive = (until) => {
    archiveTimer = setTimeout(async () => {
      archiveTimer = null;
      const key = runKey;
      try {
        const { shots } = await api.shots({ since: summary.startedAt - 60, limit: 1 });
        const shot = shots?.[0];
        if (mode !== "summary" || runKey !== key) return;
        if (shot && Math.abs(shot.started_at - summary.startedAt) <= ARCHIVE_MATCH_S) {
          summary = {
            ...summary,
            archived: true,
            seconds: shot.duration_ms != null ? shot.duration_ms / 1000 : summary.seconds,
            weight: shot.stable_weight_g ?? shot.final_weight_g ?? summary.weight,
            ratio: shot.ratio ?? summary.ratio,
          };
          paintSummary();
          return;
        }
      } catch { /* the next poll tries again */ }
      if (mode === "summary" && runKey === key && Date.now() < until) pollArchive(until);
    }, ARCHIVE_POLL_MS);
  };

  const showSummary = (samples) => {
    clearTimers();
    mode = "summary";
    summary = { ...runSummary(samples, latest.setup?.dose_g), archived: false };
    paintSummary();
    summaryView ??= chartIn(summaryPane);
    summaryView.update(samples);
    showPane(1);
    const left = SUMMARY_KEEP_MS - (Date.now() - summary.endedAt);
    keepTimer = setTimeout(() => dismiss(), Math.min(SUMMARY_KEEP_MS, Math.max(0, left)));
    pollArchive(Date.now() + ARCHIVE_WAIT_MS);
  };

  /** Back to the screens; `seen` marks the run's summary as sent away for good. */
  const dismiss = (seen = true) => {
    clearTimers();
    if (seen) dismissedKey = runKey;
    mode = "normal";
    layer.classList.remove("show");
  };

  // live.js delivers coffees only (steam, hot water and utility runs name no
  // phase or are flagged), the whole run on connect and every sample after.
  const onRun = (samples) => {
    const last = samples.at(-1);
    if (!last) return;
    const key = runStart(samples);
    lastSampleAt = Date.now();
    if (last.process?.active === true) {
      if (mode !== "live" || key !== runKey) enterLive(key);
      paintLive(samples);
    } else if (mode === "live" && key === runKey && Date.now() - last.t < SUMMARY_KEEP_MS) {
      paintLive(samples);
      clearTimeout(summaryTimer);
      summaryTimer = setTimeout(() => showSummary(samples), SUMMARY_DELAY_MS);
    } else if (mode === "normal" && key !== dismissedKey && Date.now() - last.t < SUMMARY_KEEP_MS) {
      // Opened, or reconnected, after the coffee: straight to its summary.
      runKey = key;
      showSummary(samples);
    }
  };

  // ---- weighing what is left of the bag ------------------------------------
  // The machine's Bluetooth scale, read from the live stream (status.weight):
  // first the empty container, kept here as the tare (firmware 1.9.0 has no
  // remote tare), then the beans poured in. The scale only connects while the
  // machine is on and out of standby, so the card says what is missing.
  const calibLayer = view.querySelector(".kiosk-calib");
  const calibCell = (key) => calibLayer.querySelector(`[data-calib="${key}"]`);
  const calibAct = (key) => calibLayer.querySelector(`[data-calib-act="${key}"]`);
  /** null while closed; "tare" (the container) or "fill" (the beans). */
  let calib = null;
  let tare = 0;
  /** Recent scale readings, to tell a settled weight from one still moving. */
  let readings = [];

  const net = () => Math.round(((status?.weight ?? 0) - tare) * 10) / 10;
  const steady = () => {
    const now = Date.now();
    if (!readings.length || now - readings[0].t < STEADY_MS) return false;
    const values = readings.filter((r) => now - r.t <= STEADY_MS).map((r) => r.g);
    return values.length >= 3 && Math.max(...values) - Math.min(...values) <= STEADY_G;
  };
  const paintCalib = () => {
    if (!calib) return;
    const machine = status != null && status.mode !== "standby";
    const scale = machine && status.scale?.connected === true;
    const battery = status?.scale?.battery;
    calibCell("scale").textContent = battery != null ? t("kiosk.calib.scale", { pct: battery }) : t("kiosk.calib.scale_unknown");
    calibCell("scale").hidden = !scale;
    calibCell("hint").textContent = !machine ? t("kiosk.calib.no_machine")
      : !scale ? t("kiosk.calib.no_scale")
      : t(calib === "tare" ? "kiosk.calib.tare_hint" : "kiosk.calib.fill_hint");
    calibCell("weight").textContent = !scale ? "–" : (calib === "tare" ? Math.round((status.weight ?? 0) * 10) / 10 : net()).toFixed(1);
    const held = latest.stock?.remaining_g;
    const notes = [];
    if (calib === "fill") notes.push(t("kiosk.calib.tare_info", { g: tare.toFixed(1) }));
    if (held != null) notes.push(t("kiosk.calib.was", { g: held }));
    if (scale && !steady()) notes.push(t("kiosk.calib.settling"));
    calibCell("sub").textContent = notes.join(" · ");
    calibAct("back").hidden = calib !== "fill";
    const next = calibAct("next");
    next.textContent = calib === "tare" ? t("kiosk.calib.tare_btn") : t("kiosk.calib.save_btn", { g: net().toFixed(1) });
    next.disabled = !scale || !steady() || (calib === "fill" && net() <= 0);
  };
  const openCalib = () => {
    if (mode !== "normal" || !latest.setup?.coffee_id) return;
    // A grind pressed just before is saved, not left behind the card.
    if (saveTimer) { clearTimeout(saveTimer); saveGrind(); }
    calib = "tare";
    tare = 0;
    calibLayer.classList.add("show");
    paintCalib();
  };
  const closeCalib = () => {
    calib = null;
    calibLayer.classList.remove("show");
  };
  const onCalibAction = async (key) => {
    if (key === "cancel") return closeCalib();
    if (key === "back") { calib = "tare"; tare = 0; return paintCalib(); }
    if (calib === "tare") {
      tare = Math.round((status?.weight ?? 0) * 10) / 10;
      calib = "fill";
      // The beans start moving the scale now; only readings from here on count as settled.
      readings = [];
      return paintCalib();
    }
    const grams = net();
    calibAct("next").disabled = true;
    try {
      await api.calibrateStock(grams);
      toast(t("kiosk.calib.saved", { g: grams.toFixed(1) }));
      closeCalib();
      await refresh();
    } catch (err) {
      toast(err.message, "bad");
      paintCalib();
    }
  };

  // ---- swipe -------------------------------------------------------------
  // Touch events with touch-action: none — the page, not the browser, decides
  // what a drag is (mouse too, for a desktop browser; WPE also sends a mouse
  // event after each tap, so mouse input right after a touch is ignored).
  // A touch that moved past DRAG_PX swallows the click that may follow it,
  // so a swipe that starts on a button never presses it.
  let start = null;
  let swallowClick = false;
  let lastTouch = 0;
  const point = (e) => (e.changedTouches ? e.changedTouches[0] : e);
  const isEcho = (e) => !e.changedTouches && Date.now() - lastTouch < 800;
  const onDown = (e) => {
    if (e.changedTouches) lastTouch = Date.now();
    else if (isEcho(e) || e.button !== 0) return;
    const p = point(e);
    // Over the live layer a touch moves nothing: it is locked while the
    // coffee runs, and on the summary any touch is the way back.
    start = { x: p.clientX, y: p.clientY, dragging: false, layer: mode !== "normal" || calib != null, mode };
  };
  const onMove = (e) => {
    if (!start || start.layer || isEcho(e)) return;
    const p = point(e);
    const dx = p.clientX - start.x, dy = p.clientY - start.y;
    if (!start.dragging && Math.abs(dx) > DRAG_PX && Math.abs(dx) > Math.abs(dy)) {
      start.dragging = true;
      track.classList.add("dragging");
    }
    if (start.dragging) {
      // Resistance at either end: there is no screen to pull in.
      const edge = (index === 0 && dx > 0) || (index === screens.length - 1 && dx < 0);
      place(edge ? dx / 4 : dx);
    }
  };
  const onUp = (e) => {
    if (!start || isEcho(e)) return;
    if (e.changedTouches) lastTouch = Date.now();
    if (start.layer) {
      // Only a touch that began on the summary: a finger resting on the live
      // screen as the summary slides in must not send it away.
      if (mode === "summary" && start.mode === "summary") {
        dismiss();
        // The click that follows would land on whatever the layer uncovered.
        swallowClick = true;
        setTimeout(() => (swallowClick = false), 400);
      }
      start = null;
      return;
    }
    const dx = point(e).clientX - start.x;
    if (start.dragging) {
      // Not every drag is followed by a click; one that is not must not
      // leave the next real tap swallowed.
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 400);
      track.classList.remove("dragging");
      if (Math.abs(dx) > frame.clientWidth * SWIPE_SHARE) index = Math.min(screens.length - 1, Math.max(0, index - Math.sign(dx)));
      place();
    }
    start = null;
  };
  const onCancel = () => { if (start?.dragging) { track.classList.remove("dragging"); place(); } start = null; };
  const onClickCapture = (e) => {
    if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); }
  };
  const onClick = (e) => {
    const act = e.target.closest("[data-calib-act]");
    if (act) return onCalibAction(act.dataset.calibAct);
    if (calib) return;
    if (e.target.closest("[data-calib-open]")) return openCalib();
    const grind = e.target.closest("[data-grind]");
    if (grind) stepGrind(Number(grind.dataset.grind));
  };

  frame.addEventListener("touchstart", onDown, { passive: true });
  frame.addEventListener("touchmove", onMove, { passive: true });
  frame.addEventListener("touchend", onUp);
  frame.addEventListener("touchcancel", onCancel);
  frame.addEventListener("mousedown", onDown);
  frame.addEventListener("mousemove", onMove);
  frame.addEventListener("mouseup", onUp);
  frame.addEventListener("mouseleave", onCancel);
  frame.addEventListener("click", onClickCapture, true);
  view.addEventListener("click", onClick);
  const timer = setInterval(refresh, REFRESH_MS);

  // Subscribed last. The run watchLive hands over synchronously is the page's
  // cached one, possibly from before the stream last closed; the server's own
  // copy, or the next status of a run in progress, follows within a second.
  let subscribing = true;
  const stopLive = watchLive({
    onRun: (samples) => { if (!subscribing) onRun(samples); },
    onStatus: (next) => {
      status = next;
      if (next.scale?.connected) {
        readings.push({ t: Date.now(), g: next.weight ?? 0 });
        readings = readings.filter((r) => Date.now() - r.t <= STEADY_MS * 2);
      } else readings = [];
      paintTiles();
      paintCalib();
    },
    onOffline: () => { liveCell("offline").hidden = false; status = null; readings = []; paintTiles(); paintCalib(); },
    onOnline: () => (liveCell("offline").hidden = true),
  });
  subscribing = false;
  const staleTimer = setInterval(() => {
    // Unlocked, not dismissed: should the stream come back, the summary still shows.
    if (mode === "live" && Date.now() - lastSampleAt > STALE_MS) dismiss(false);
  }, 5000);

  return () => {
    stopLive();
    clearTimers();
    clearInterval(staleTimer);
    liveView?.destroy();
    summaryView?.destroy();
    clearInterval(timer);
    // A pressed grind is saved on the way out, not dropped.
    if (saveTimer) { clearTimeout(saveTimer); saveGrind(); }
    view.removeEventListener("click", onClick);
    root.classList.remove("kiosk");
    if (themeBefore) root.dataset.theme = themeBefore;
  };
}
