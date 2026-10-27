// Matchframe Sample CS2 HUD.
//
// The HUD server opens this page with ?output=…&variant=…&t=… and serves the read-only SDK at
// /sdk/hud-sdk.js. Every snapshot is the complete public HUD state, including this HUD's settings
// from the HUD Library, so the page simply re-renders on each one.
import { HudClient, displayClock, formatClock } from "/sdk/hud-sdk.js";

const q = new URLSearchParams(location.search);
const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/overlay-ws?output=${encodeURIComponent(q.get("output") ?? "main")}&variant=${encodeURIComponent(q.get("variant") ?? "live")}&t=${encodeURIComponent(q.get("t") ?? "")}`;

const $ = (sel, root = document) => root.querySelector(sel);
const hud = $("#hud");
let last = null;

const setting = (state, key, fallback) => (state.settings && key in state.settings ? state.settings[key] : fallback);

function applySettings(state) {
  const accent = setting(state, "accentColor", "#2f7cf6");
  if (typeof accent === "string" && /^#[0-9a-f]{3,8}$/i.test(accent)) document.documentElement.style.setProperty("--accent", accent);
  const opacity = Number(setting(state, "panelOpacity", 0.86));
  if (Number.isFinite(opacity)) document.documentElement.style.setProperty("--panel", `rgba(12, 16, 24, ${Math.min(1, Math.max(0.4, opacity))})`);
}

function renderTeam(el, team, state) {
  el.className = `team team-${el.classList.contains("team-left") ? "left" : "right"}${team.side ? ` side-${team.side}` : ""}`;
  $(".team-name", el).textContent = setting(state, "teamNames", "short") === "full" ? team.name : team.shortName || team.name;
  $(".team-score", el).textContent = team.score ?? "–";
  const logo = $(".team-logo", el);
  logo.hidden = !team.logoUrl;
  if (team.logoUrl && logo.getAttribute("src") !== team.logoUrl) logo.src = team.logoUrl;
}

function playerRow(p, state, align) {
  const row = document.createElement("div");
  row.className = `player${p.side ? ` side-${p.side}` : ""}${p.alive === false ? " dead" : ""}${p.observed ? " is-observed" : ""}`;
  const hp = p.health ?? 0;
  const weapon = p.activeWeapon?.displayName ?? p.primary?.displayName ?? p.secondary?.displayName ?? "";
  const money = setting(state, "showMoney", true) && p.money !== null ? `<b>$${p.money.toLocaleString("en-US")}</b><br>` : "";
  const cells = [`<span class="player-hp"></span>`, `<span class="player-mid"><span class="player-name"></span><span class="player-bar"><i></i></span></span>`, `<span class="player-side">${money}<span class="player-weapon"></span></span>`];
  // The right-hand team mirrors the left: health on the outside edge.
  row.innerHTML = (align === "right" ? cells.reverse() : cells).join("");
  $(".player-hp", row).textContent = p.alive === false ? "" : String(hp);
  $(".player-name", row).textContent = p.name;
  $(".player-weapon", row).textContent = weapon;
  const bar = $(".player-bar i", row);
  bar.style.width = `${Math.max(0, Math.min(100, hp))}%`;
  if (hp <= 25) bar.classList.add("low");
  return row;
}

function renderPlayers(el, team, state, align) {
  el.hidden = setting(state, "showPlayers", true) === false;
  el.replaceChildren(...team.players.slice(0, 5).map((p) => playerRow(p, state, align)));
}

function renderObserved(state) {
  const el = $(".observed");
  const p = state.observed;
  el.hidden = !p || setting(state, "showObserved", true) === false;
  if (!p) return;
  $(".observed-name", el).textContent = p.name;
  const w = p.activeWeapon;
  $(".observed-weapon", el).textContent = w ? `${w.displayName}${w.ammoClip !== null ? `  ${w.ammoClip}/${w.ammoReserve ?? "–"}` : ""}` : "";
  $(".observed-hp", el).textContent = p.health ?? "–";
  $(".observed-armor", el).textContent = p.armor !== null ? `Armor ${p.armor}${p.helmet ? " + helmet" : ""}` : "";
  $(".observed-kda", el).textContent = p.kills !== null ? `K ${p.kills} · A ${p.assists ?? "–"} · D ${p.deaths ?? "–"}` : "";
}

function render(state) {
  hud.hidden = false;
  applySettings(state);
  renderTeam($(".team-left"), state.left, state);
  renderTeam($(".team-right"), state.right, state);
  const m = state.match;
  const half = m.regulationRounds && m.roundNumber ? (m.roundNumber <= m.regulationRounds / 2 ? "First half" : m.roundNumber <= m.regulationRounds ? "Second half" : "Overtime") : "";
  $(".clock-round").textContent = m.roundNumber ? `Round ${m.roundNumber}${half ? ` · ${half}` : ""}` : (m.mapDisplayName ?? "");
  renderPlayers($(".players-left"), state.left, state, "left");
  renderPlayers($(".players-right"), state.right, state, "right");
  renderObserved(state);
  // Honest labelling: test data and paused data are always shown.
  $(".chip.test").hidden = !state.simulated;
  $(".chip.paused").hidden = !state.stale;
}

// Clocks advance locally only while the source says they are running.
function tick() {
  if (!last) return;
  const { state, receivedAt } = last;
  const bomb = state.bomb && (state.bomb.state === "planted" || state.bomb.state === "defusing") ? state.bomb : null;
  const banner = $(".banner.bomb");
  banner.hidden = !bomb;
  if (bomb) {
    const s = displayClock(bomb.remainingSec, bomb.clockRunning, receivedAt, performance.now());
    $("span", banner).textContent = `Bomb ${bomb.state === "defusing" ? "being defused" : "planted"}${bomb.site ? ` on ${bomb.site}` : ""}${s !== null ? ` · ${formatClock(s)}` : ""}`;
  }
  const remaining = displayClock(state.match.phaseEndsInSec, state.match.clockRunning, receivedAt, performance.now());
  const time = $(".clock-time");
  time.textContent = formatClock(remaining);
  time.classList.toggle("urgent", remaining !== null && remaining <= 10 && state.match.phase === "live");
}

new HudClient({
  url: wsUrl,
  onState: (state, receivedAt) => {
    last = { state, receivedAt };
    render(state);
    tick();
  },
}).start();
setInterval(tick, 200);
