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

// ---------------------------------------------------------------- minimap
//
// state.radar holds 0–1 coordinates on its background: the built-in radar image for the map (or an
// operator-calibrated one) in mode "image", or Matchframe's outline generated from map geometry in
// mode "schematic" (fetched as JSON). Mode "none": no trustworthy transform, nothing is drawn.
const SVG = "http://www.w3.org/2000/svg";
const S = 1000;
const outlines = new Map();
const svgEl = (tag, attrs) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  return el;
};

function outline(url) {
  if (!outlines.has(url)) {
    outlines.set(url, null);
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((o) => {
        outlines.set(url, o);
        if (last) renderMinimap(last.state);
      })
      .catch(() => undefined);
  }
  return outlines.get(url);
}

const UTILITY = { smoke: "smoke", molotov: "fire", incendiary: "fire", fire_unknown: "fire", he: "he", flashbang: "flash", decoy: "decoy" };

function renderMinimap(state) {
  const box = $(".minimap");
  const r = state.radar;
  box.hidden = setting(state, "showMinimap", true) === false || !r.available || r.mode === "none";
  if (box.hidden) return;
  box.dataset.mode = r.mode;
  const svg = $("svg", box);
  const parts = [];
  if (r.mode === "image" && r.backgroundUrl) parts.push(svgEl("image", { href: r.backgroundUrl, x: 0, y: 0, width: S, height: S, preserveAspectRatio: "none" }));
  const o = r.mode === "schematic" && r.backgroundUrl ? outline(r.backgroundUrl) : null;
  if (o) {
    for (const [u, v, w, ri] of o.cells) parts.push(svgEl("rect", { x: u * S, y: v * S, width: w * S + 0.6, height: w * S + 0.6, class: `cell k-${o.regions[ri]?.kind ?? "other"}` }));
    for (const p of o.polygons) parts.push(svgEl("polygon", { points: p.points.map(([u, v]) => `${u * S},${v * S}`).join(" "), class: `cell k-${o.regions[p.regionIndex]?.kind ?? "other"}` }));
  }
  for (const u of r.utility) parts.push(svgEl("circle", { cx: u.u * S, cy: u.v * S, r: Math.max(u.type === "decoy" ? 12 : 22, (u.radius ?? 0.02) * S), class: `util ${UTILITY[u.type] ?? "other"}${u.side ? ` side-${u.side}` : ""}` }));
  if (r.bomb && r.bomb.state !== "carried") {
    const g = svgEl("g", { transform: `translate(${r.bomb.u * S} ${r.bomb.v * S})`, class: `bomb s-${r.bomb.state}` });
    g.append(svgEl("circle", { r: 30, class: "ping" }), svgEl("rect", { x: -17, y: -12, width: 34, height: 24, rx: 5, class: "body" }));
    parts.push(g);
  }
  // Dead players first, the observed player last (on top).
  const players = [...r.players].sort((a, b) => Number(a.alive) - Number(b.alive) || Number(a.observed) - Number(b.observed));
  for (const p of players) {
    const g = svgEl("g", { transform: `translate(${p.u * S} ${p.v * S})`, class: `dot${p.side ? ` side-${p.side}` : ""}${p.alive ? "" : " dead"}${p.observed ? " observed" : ""}${p.flashed ? " flashed" : ""}${p.hasBomb ? " carrier" : ""}` });
    if (p.alive) {
      if (p.yawDeg !== null) g.append(svgEl("path", { d: "M0,-42 L14,-18 L-14,-18 Z", transform: `rotate(${90 - p.yawDeg})`, class: "facing" }));
      g.append(svgEl("circle", { r: p.observed ? 27 : 22, class: "disc" }));
      if (p.label) {
        const t = svgEl("text", { y: 9, "text-anchor": "middle", class: "slot" });
        t.textContent = p.label;
        g.append(t);
      }
    } else g.append(svgEl("path", { d: "M-10,-10 L10,10 M10,-10 L-10,10", class: "cross" }));
    parts.push(g);
  }
  svg.replaceChildren(...parts);
}

// ---------------------------------------------------------------- killfeed
//
// Game data (GSI) reports no kill events: Matchframe pairs kills from counter changes (kind
// "probable"; the weapon is the killer's weapon in hand). A death without a pairing shows the victim
// only. Each kill stays on screen for KILL_MS after it first arrives.
const KILL_MS = 6000;
const firstSeen = new Map();
const killRows = new Map();

const WEAPONS = new Set(["ak47", "aug", "awp", "bizon", "c4", "cz75a", "deagle", "decoy", "elite", "famas", "fiveseven", "flashbang", "g3sg1", "galilar", "glock", "hegrenade", "hkp2000", "incgrenade", "inferno", "knife", "m249", "m4a1", "m4a1_silencer", "m4a1_silencer_off", "mac10", "mag7", "molotov", "mp5sd", "mp7", "mp9", "negev", "nova", "p250", "p90", "revolver", "sawedoff", "scar20", "sg556", "smokegrenade", "ssg08", "taser", "tec9", "ump45", "usp_silencer", "usp_silencer_off", "world", "xm1014"]);

function weaponIcon(name) {
  let id = String(name).replace(/^weapon_/, "");
  if (id.startsWith("knife") || id === "bayonet") id = "knife";
  if (WEAPONS.has(id)) {
    const img = document.createElement("img");
    img.className = "kill-weapon";
    img.alt = id;
    img.src = `images/weapons/${id}.svg`;
    return img;
  }
  const span = document.createElement("span");
  span.className = "kill-weapon-text";
  span.textContent = id.replace(/_/g, " ");
  return span;
}

function nameEl(cls, who) {
  const s = document.createElement("span");
  s.className = `${cls}${who.side ? ` side-${who.side}` : ""}`;
  s.textContent = who.name;
  return s;
}

function renderKillfeed(state, now) {
  const el = $(".killfeed");
  if (setting(state, "showKillfeed", true) === false) return el.replaceChildren();
  const entries = state.killfeed.entries;
  for (const e of entries) if (!firstSeen.has(e.id)) firstSeen.set(e.id, now);
  for (const id of [...firstSeen.keys()]) if (!entries.some((e) => e.id === id)) firstSeen.delete(id);
  const rows = entries.filter((e) => now - firstSeen.get(e.id) < KILL_MS).slice(-5);
  const keep = new Set(rows.map((e) => e.id));
  for (const [id, row] of killRows) {
    if (!keep.has(id)) {
      row.remove();
      killRows.delete(id);
    }
  }
  for (const e of rows) {
    let row = killRows.get(e.id);
    if (!row) {
      row = document.createElement("div");
      killRows.set(e.id, row);
      const suicide = e.killer && e.killer.steamId === e.victim.steamId;
      row.className = `kill${e.killer && !suicide && e.killer.side ? ` by-${e.killer.side}` : ""}`;
      if (e.killer && !suicide) {
        row.append(nameEl("kill-name", e.killer));
        if (e.assister) {
          const plus = document.createElement("span");
          plus.className = "kill-plus";
          plus.textContent = "+";
          row.append(plus, nameEl("kill-assist", e.assister));
        }
      }
      if (e.attackerBlind) row.append(Object.assign(document.createElement("span"), { className: "kill-mark blind", title: "Killer was flashed" }));
      if (e.weapon && !suicide) row.append(weaponIcon(e.weapon));
      else row.append(Object.assign(document.createElement("span"), { className: "kill-mark skull", title: suicide ? "Suicide" : "Eliminated" }));
      if (e.headshot) row.append(Object.assign(document.createElement("span"), { className: "kill-mark headshot", title: "Headshot" }));
      row.append(nameEl("kill-name victim", e.victim));
      el.append(row);
    }
    row.classList.toggle("leaving", now - firstSeen.get(e.id) > KILL_MS - 500);
  }
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
  renderMinimap(state);
  renderKillfeed(state, performance.now());
  // Honest labelling: test data and paused data are always shown.
  $(".chip.test").hidden = !state.simulated;
  $(".chip.paused").hidden = !state.stale;
}

// Clocks advance locally only while the source says they are running.
function tick() {
  if (!last) return;
  const { state, receivedAt } = last;
  renderKillfeed(state, performance.now());
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
