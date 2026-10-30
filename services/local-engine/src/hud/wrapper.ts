import type { HudOutputMode } from "@matchframe/contracts";

/**
 * Output page for library HUDs (`GET /hud/<id>/<variant>`): engine-generated, trusted HTML that
 * loads the HUD in a frame at its design resolution and scales it uniformly to fit (letterboxed,
 * never stretched). It has no inline script (the overlay CSP allows only 'self' scripts); its
 * behaviour is in WRAPPER_JS, served at /hud-runtime/wrapper.js.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export interface WrapperPageOptions {
  hudId: string;
  name: string;
  variant: string;
  mode: HudOutputMode;
  /** Checkerboard behind the HUD (preview mode only). */
  checker: boolean;
  /** Show a TEST DATA badge while the simulation runs (for HUDs that do not label it themselves). */
  testDataBadge?: boolean;
  /** Same-origin URL of the HUD page the frame loads. */
  frameUrl: string;
  /** Path and query of the control socket (/hud-runtime-ws?...). */
  controlPath: string;
  width: number;
  height: number;
}

export function wrapperPage(o: WrapperPageOptions): string {
  const cls = [`mf-mode-${o.mode}`, o.checker && o.mode === "preview" ? "mf-checker" : ""].filter(Boolean).join(" ");
  return `<!doctype html>
<html lang="en" class="${cls}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.name)} - Matchframe HUD</title>
<style>
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
#mf-stage { position: absolute; left: 0; top: 0; z-index: 1; transform-origin: 0 0; }
#mf-stage iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
#mf-checker, #mf-edit { position: absolute; display: none; box-sizing: border-box; pointer-events: none; }
#mf-checker { z-index: 0; }
#mf-edit { z-index: 2; }
html.mf-checker #mf-checker { display: block; background-color: #d0d0d0; background-image: linear-gradient(45deg, #a9a9a9 25%, transparent 25%, transparent 75%, #a9a9a9 75%), linear-gradient(45deg, #a9a9a9 25%, transparent 25%, transparent 75%, #a9a9a9 75%); background-size: 32px 32px; background-position: 0 0, 16px 16px; }
html.mf-editing #mf-edit { display: block; pointer-events: auto; cursor: move; outline: 3px dashed #ffb400; outline-offset: -3px; background: rgba(255, 180, 0, 0.08); -webkit-app-region: drag; app-region: drag; }
#mf-test { position: absolute; z-index: 3; left: 50%; top: 8px; transform: translateX(-50%); display: none; padding: 3px 10px; border-radius: 4px; background: #7c3aed; color: #fff; font: 700 12px/1.4 system-ui, sans-serif; letter-spacing: 0.08em; pointer-events: none; }
html.mf-test-data #mf-test { display: block; }
#mf-label { position: absolute; left: 10px; top: 10px; padding: 4px 8px; border-radius: 4px; background: rgba(17, 20, 27, 0.88); color: #fff; font: 600 13px/1.3 system-ui, sans-serif; white-space: nowrap; }
</style>
</head>
<body data-hud="${esc(o.hudId)}" data-variant="${esc(o.variant)}" data-mode="${o.mode}" data-frame="${esc(o.frameUrl)}" data-control="${esc(o.controlPath)}" data-width="${o.width}" data-height="${o.height}">
<div id="mf-checker"></div>
<div id="mf-stage"></div>
<div id="mf-edit"><span id="mf-label"></span></div>
${o.testDataBadge ? '<div id="mf-test">TEST DATA</div>' : ""}
<script src="/hud-runtime/wrapper.js"></script>
</body>
</html>
`;
}

/**
 * Wrapper behaviour (browser script, ES5 so it runs in every OBS/Chromium build):
 * - scales the design-size stage to fit the viewport, centred, on every resize;
 * - connects to the control socket with backoff; hides the frame while hidden, removes it while
 *   stopped (recreates it on start) and reloads it when reloadSeq changes;
 * - window.__mfOverlay.setEdit(true|false) shows the edit outline and size label (desktop mode
 *   only); window.__mfOverlay.status() reports the state for automated checks;
 * - times its own frames (the HUD frame shares its main thread) and reports every 5 s how smoothly
 *   it draws where it runs: frames a second, the longest pause, pauses over 100 ms, and how long its
 *   tasks wait (an LHM HUD that can't keep up gets fewer game-data updates).
 */
export const WRAPPER_JS = String.raw`(function () {
  "use strict";
  var body = document.body;
  var cfg = {
    hud: body.getAttribute("data-hud") || "",
    mode: body.getAttribute("data-mode") || "obs",
    frame: body.getAttribute("data-frame") || "",
    control: body.getAttribute("data-control") || "",
    width: Number(body.getAttribute("data-width")) || 1920,
    height: Number(body.getAttribute("data-height")) || 1080
  };
  var stage = document.getElementById("mf-stage");
  var checker = document.getElementById("mf-checker");
  var edit = document.getElementById("mf-edit");
  var label = document.getElementById("mf-label");
  var frame = null;
  var gotControl = false;
  var st = { connected: false, frameLoaded: false, stopped: false, hidden: false, reloadSeq: null, editing: false, scale: 1, testData: false };

  function place(el, x, y, w, h) {
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.width = w + "px";
    el.style.height = h + "px";
  }

  // Uniform scale to fit, centred: letterboxed, never stretched.
  function layout() {
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var s = Math.min(vw / cfg.width, vh / cfg.height);
    if (!isFinite(s) || s <= 0) s = 1;
    var w = cfg.width * s;
    var h = cfg.height * s;
    var x = (vw - w) / 2;
    var y = (vh - h) / 2;
    st.scale = s;
    stage.style.width = cfg.width + "px";
    stage.style.height = cfg.height + "px";
    stage.style.transform = "translate(" + x + "px, " + y + "px) scale(" + s + ")";
    place(checker, x, y, w, h);
    place(edit, x, y, w, h);
    label.textContent = cfg.width + "×" + cfg.height + " · " + Math.round(s * 100) + "% · " + Math.round(w) + "×" + Math.round(h);
  }

  function applyHidden() {
    stage.style.visibility = st.hidden ? "hidden" : "visible";
  }

  function createFrame() {
    if (frame) return;
    var f = document.createElement("iframe");
    f.title = "HUD";
    f.setAttribute("scrolling", "no");
    f.setAttribute("allowtransparency", "true");
    f.setAttribute("referrerpolicy", "no-referrer");
    f.addEventListener("load", function () {
      if (frame === f) st.frameLoaded = true;
    });
    f.src = cfg.frame;
    st.frameLoaded = false;
    frame = f;
    stage.appendChild(f);
  }

  function removeFrame() {
    if (!frame) return;
    if (frame.parentNode) frame.parentNode.removeChild(frame);
    frame = null;
    st.frameLoaded = false;
  }

  function onControl(msg) {
    if (!msg || msg.type !== "control") return;
    var d = msg.designResolution;
    if (d && d.width > 0 && d.height > 0 && (d.width !== cfg.width || d.height !== cfg.height)) {
      cfg.width = d.width;
      cfg.height = d.height;
      layout();
    }
    var reload = st.reloadSeq !== null && msg.reloadSeq !== st.reloadSeq;
    gotControl = true;
    st.reloadSeq = msg.reloadSeq;
    st.hidden = !!msg.hidden;
    st.stopped = !!msg.stopped;
    st.testData = !!msg.testData;
    document.documentElement.className = document.documentElement.className.replace(/\s*mf-test-data/g, "") + (st.testData ? " mf-test-data" : "");
    applyHidden();
    if (st.stopped) {
      removeFrame();
    } else if (!frame) {
      createFrame();
    } else if (reload) {
      removeFrame();
      createFrame();
    }
  }

  // Frame timing where the output runs (OBS's browser source, the desktop HUD). A gap over 10 s is
  // a paused source (hidden in OBS), not a stall.
  var ctl = null;
  var perf = { frames: 0, worst: 0, pauses: 0, last: 0, since: 0 };
  function frameTick(t) {
    if (perf.last && document.visibilityState !== "hidden") {
      var gap = t - perf.last;
      if (gap < 10000) {
        perf.frames += 1;
        if (gap > perf.worst) perf.worst = gap;
        if (gap > 100) perf.pauses += 1;
      }
    }
    perf.last = t;
    window.requestAnimationFrame(frameTick);
  }
  // How long this page's tasks wait (the HUD in the frame shares its main thread): a message to
  // itself every 100 ms. Long waits mean the HUD has more work than the computer gives it time for.
  var waits = [];
  var pings = [];
  var ping = new MessageChannel();
  ping.port1.onmessage = function () {
    if (pings.length) waits.push(performance.now() - pings.shift());
  };
  setInterval(function () {
    pings.push(performance.now());
    ping.port2.postMessage(0);
  }, 100);
  function reportPerf() {
    var now = performance.now();
    var secs = (now - perf.since) / 1000;
    if (ctl && ctl.readyState === 1 && perf.frames > 0 && secs > 0 && frame && !st.hidden) {
      waits.sort(function (a, b) { return a - b; });
      var lag = waits.length ? Math.round(waits[Math.floor(waits.length * 0.9)]) : 0;
      try {
        ctl.send(JSON.stringify({ type: "perf", fps: Math.round(perf.frames / secs), worstMs: Math.round(perf.worst), pauses: perf.pauses, lagMs: lag }));
      } catch (e) {}
    }
    perf.frames = 0;
    perf.worst = 0;
    perf.pauses = 0;
    perf.since = now;
    waits = [];
  }

  var attempt = 0;
  function schedule() {
    var delay = Math.min(8000, 500 * Math.pow(2, attempt));
    attempt += 1;
    setTimeout(connect, delay);
  }

  function connect() {
    var url = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + cfg.control;
    var ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      schedule();
      return;
    }
    ws.onopen = function () {
      attempt = 0;
      st.connected = true;
      ctl = ws;
    };
    ws.onmessage = function (ev) {
      var msg = null;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch (e) {
        return;
      }
      onControl(msg);
    };
    ws.onclose = function () {
      st.connected = false;
      if (ctl === ws) ctl = null;
      schedule();
    };
  }

  function setEdit(on) {
    if (cfg.mode !== "desktop") return false;
    st.editing = !!on;
    var cls = document.documentElement.classList;
    if (st.editing) cls.add("mf-editing");
    else cls.remove("mf-editing");
    layout();
    return st.editing;
  }

  window.__mfOverlay = {
    setEdit: setEdit,
    status: function () {
      return { connected: st.connected, frameLoaded: st.frameLoaded, stopped: st.stopped, hidden: st.hidden, reloadSeq: st.reloadSeq, mode: cfg.mode, editing: st.editing, scale: st.scale, designResolution: { width: cfg.width, height: cfg.height } };
    }
  };

  window.addEventListener("resize", layout);
  layout();
  connect();
  perf.since = performance.now();
  window.requestAnimationFrame(frameTick);
  setInterval(reportPerf, 5000);
  // Without a control message (socket unavailable), show the HUD anyway after a short wait.
  setTimeout(function () {
    if (!gotControl && !frame) createFrame();
  }, 1500);
})();
`;
