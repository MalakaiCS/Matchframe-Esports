// Match graphics in the running program (desktop and packaged smoke tests): a match is created, its
// "Thumbnails & stingers" tab is opened, and the program draws the thumbnails and encodes the two
// stingers itself (WebCodecs in the program's window). Checks the six files the engine then holds:
// PNGs of the right size, and WebM VP8 stingers marked with an alpha channel.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
// AlphaMode (0x53C0), size 1, value 1.
const ALPHA_MODE = Buffer.from([0x53, 0xc0, 0x81, 0x01]);
const SIZES = { "thumb-highlights": [1280, 720], "thumb-replay": [1280, 720], "thumb-live": [1280, 720], "up-next": [1920, 1080] };

async function checkMatchArt({ win, base, waitFor, assert, shot }) {
  const token = await win.evaluate(() => window.matchframe.getOperatorToken());
  const call = async (path, body) => {
    const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  };
  const a = await call("/api/v1/teams", { name: "Northern Lights", shortName: "NL", primaryColor: "#1d3fbf" });
  const b = await call("/api/v1/teams", { name: "Redline", shortName: "RED" });
  const m = await call("/api/v1/matches", { teamAId: a.id, teamBId: b.id, title: "Smoke final", format: { bestOf: 1, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false }, mapPool: ["de_mirage"] });
  assert(typeof m.id === "string", `match created (${JSON.stringify(m)})`);
  // The Matches page opens the newest match; its graphics tab makes them when there are none yet.
  await win.evaluate(() => (location.href = "app://matchframe/matches"));
  const tab = await waitFor(() => win.evaluate(() => [...document.querySelectorAll('[role="tab"]')].some((t) => t.textContent.includes("Thumbnails"))), 60000);
  assert(tab, "the match's Thumbnails & stingers tab is shown");
  await win.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes("Thumbnails")).click());
  const started = Date.now();
  const art = await waitFor(async () => {
    const r = await call(`/api/v1/matches/${m.id}/art`);
    if (r.items.length >= 6) return r;
    // A failed run shows its reason in the panel: stop early with it.
    const failed = await win.evaluate(() => document.querySelector(".note.tone-warn")?.textContent ?? null);
    return failed ? { failed } : null;
  }, 240000);
  assert(!art.failed, `the program made the match graphics (${art.failed})`);
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const files = {};
  for (const item of art.items) {
    const bytes = Buffer.from(await (await fetch(base + item.url)).arrayBuffer());
    files[item.kind] = bytes.length;
    if (SIZES[item.kind]) {
      assert(bytes.subarray(0, 8).equals(PNG), `${item.kind} is a PNG`);
      const [w, h] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
      assert(w === SIZES[item.kind][0] && h === SIZES[item.kind][1], `${item.kind} is ${SIZES[item.kind].join("×")} (${w}×${h})`);
    } else {
      assert(bytes.subarray(0, 4).equals(EBML), `${item.kind} is a WebM file`);
      const head = bytes.subarray(0, 512);
      assert(head.includes(Buffer.from("V_VP8")) && head.includes(ALPHA_MODE), `${item.kind} is VP8 with an alpha channel`);
      assert(bytes.length > 100000, `${item.kind} has its frames (${bytes.length} bytes)`);
    }
  }
  if (shot) await win.screenshot({ path: shot });
  return { matchId: m.id, seconds, files };
}

module.exports = { checkMatchArt };
