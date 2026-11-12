import { t } from "../lib/i18n.js";
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

function brewingCard(data, grind) {
  const s = data.setup;
  if (!s) return `<section class="card"><div class="card-head"><h2>${t("now.brewing")}</h2></div><p class="muted">${t("now.no_setup")}</p></section>`;
  return `
    <section class="card brewing-card">
      <h2>${t("now.brewing")}</h2>
      <div class="bean">${s.bean ?? "?"}</div>
      <div class="roaster">${s.roaster ?? ""}${s.roast_date ? " · " + s.roast_date : ""}</div>
      <p class="since">${t("setup.since")} ${fmt.dateTime(s.valid_from)}</p>
      ${data.stock?.remaining_g != null ? `<p class="stock">${data.stock.low ? `<span class="pill warn">${t("now.stock_low")}</span> ` : ""}${t("now.stock", { g: data.stock.remaining_g, days: data.stock.days_left != null ? t("coffees.days", { n: data.stock.days_left }) : "–" })}</p>` : ""}
      <div class="label grind-label">${t("now.grind")}</div>
      <div class="stepper">
        <button type="button" data-grind="-1" aria-label="${t("kiosk.finer")}">−</button>
        <span class="value num" data-grind-value>${grind ?? "–"}</span>
        <button type="button" data-grind="1" aria-label="${t("kiosk.coarser")}">+</button>
      </div>
      <div class="dose num">${s.dose_g != null ? s.dose_g + " g" : "–"}</div>
      <div class="label">${t("now.dose")}</div>
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
    </div>`;
  const frame = view.querySelector(".kiosk-frame");
  const track = view.querySelector(".kiosk-track");
  const screens = [...view.querySelectorAll(".kiosk-screen")];
  const dots = [...view.querySelectorAll(".kiosk-dots i")];

  const draw = () => {
    screens[0].innerHTML = brewingCard(latest, pendingGrind ?? latest.setup?.grind_setting);
    screens[1].innerHTML = maintenanceCard(latest);
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
    start = { x: p.clientX, y: p.clientY, dragging: false, layer: mode !== "normal", mode };
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
    onOffline: () => (liveCell("offline").hidden = false),
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
