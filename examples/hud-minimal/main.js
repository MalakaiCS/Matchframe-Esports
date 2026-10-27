// The engine serves the read-only SDK to every HUD package at /sdk/hud-sdk.js.
import { HudClient, displayClock, formatClock } from "/sdk/hud-sdk.js";

const q = new URLSearchParams(location.search);
const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/overlay-ws?output=${encodeURIComponent(q.get("output") ?? "main")}&variant=${encodeURIComponent(q.get("variant") ?? "live")}&t=${encodeURIComponent(q.get("t") ?? "")}`;
const $ = (id) => document.getElementById(id);
let last = null;

new HudClient({
  url,
  onState: (state, receivedAt) => {
    last = { state, receivedAt };
    $("bug").hidden = false;
    $("sim").hidden = !state.simulated;
    $("left-name").textContent = state.left.shortName;
    $("right-name").textContent = state.right.shortName;
    $("left-score").textContent = state.left.score ?? "–";
    $("right-score").textContent = state.right.score ?? "–";
  },
}).start();

// Clocks only extrapolate while the source says they are running (and never far past an update).
setInterval(() => {
  if (!last) return;
  const m = last.state.match;
  // receivedAt is performance.now() — compare against the same clock.
  $("clock").textContent = formatClock(displayClock(m.phaseEndsInSec, m.clockRunning, last.receivedAt, performance.now()));
}, 200);
