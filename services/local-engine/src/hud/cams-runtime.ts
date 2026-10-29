/**
 * Player cams in HUDs and OBS (ADR-048): browser scripts served by the HUD server.
 *
 * - CAMS_JS (`/hud-runtime/cams.js`): window.MatchframeCams. Connects to `/cams-ws` (with the page's
 *   `t` and `output`, or an LHM HUD's cookie), decodes each on-air cam with WebCodecs into a canvas,
 *   and gives HUDs that canvas or a MediaStream of it. The engine already delays the video.
 * - LHM_CAMS_JS (`/hud-runtime/lhm-cams.js`, put into LHM-format HUD pages before their own
 *   scripts): LHM HUDs receive player cams as WebRTC offers (`offerFromPlayer`) and play the stream
 *   simple-peer gives them. Matchframe's offers carry a marker; for those, the page's
 *   RTCPeerConnection answers locally and hands over the cam's MediaStream, with no network
 *   connection (every other use of RTCPeerConnection is the browser's own).
 * - CAM_PAGE_JS and camPage(): the OBS browser sources `/cams/observed` and `/cams/player/<id>`.
 *
 * Plain ES2017 (OBS's browser has WebCodecs from Chromium 94).
 */

export const CAMS_JS = String.raw`(function () {
  "use strict";
  if (window.MatchframeCams) return;
  var q = new URLSearchParams(location.search);
  var auth = "t=" + encodeURIComponent(q.get("t") || "") + "&output=" + encodeURIComponent(q.get("output") || "");
  var cams = {};
  var list = [];
  var observed = null;
  var delayMs = 0;
  var handlers = { change: [], observed: [] };
  var ws = null;
  var retry = 1000;

  function emit(ev) {
    var hs = handlers[ev].slice();
    for (var i = 0; i < hs.length; i++) {
      try { hs[i](); } catch (e) { /* a HUD's listener */ }
    }
  }
  function cam(id) {
    var c = cams[id];
    if (!c) {
      var canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      c = cams[id] = { canvas: canvas, ctx: canvas.getContext("2d"), decoder: null, codec: null, wantKey: true, stream: null, frameAt: 0 };
    }
    return c;
  }
  function clear(c) {
    c.ctx.clearRect(0, 0, c.canvas.width, c.canvas.height);
    c.wantKey = true;
  }
  function decoderFor(c, h) {
    if (typeof VideoDecoder === "undefined") return null;
    if (c.decoder && c.decoder.state !== "closed" && c.codec === h.c) return c.decoder;
    c.codec = h.c;
    c.decoder = new VideoDecoder({
      output: function (frame) {
        var cv = c.canvas;
        if (cv.width !== frame.displayWidth || cv.height !== frame.displayHeight) {
          cv.width = frame.displayWidth;
          cv.height = frame.displayHeight;
        }
        c.ctx.drawImage(frame, 0, 0);
        frame.close();
        c.frameAt = performance.now();
      },
      error: function () {
        c.decoder = null;
        c.wantKey = true;
      }
    });
    c.decoder.configure({ codec: h.c || "vp8", codedWidth: h.w, codedHeight: h.h, optimizeForLatency: true });
    c.wantKey = true;
    return c.decoder;
  }
  function onFrame(buf) {
    var u8 = new Uint8Array(buf);
    var n = u8[0];
    var h;
    try { h = JSON.parse(new TextDecoder().decode(u8.subarray(1, 1 + n))); } catch (e) { return; }
    var c = cam(h.s);
    var d = decoderFor(c, h);
    if (!d) return;
    if (c.wantKey && !h.k) return;
    // Decoding fell behind: drop to the next keyframe rather than lag.
    if (d.decodeQueueSize > 15 && !h.k) {
      c.wantKey = true;
      return;
    }
    c.wantKey = false;
    try {
      d.decode(new EncodedVideoChunk({ type: h.k ? "key" : "delta", timestamp: h.t, data: u8.subarray(1 + n) }));
    } catch (e) {
      c.wantKey = true;
    }
  }
  function connect() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/cams-ws?" + auth);
    ws.binaryType = "arraybuffer";
    ws.onopen = function () {
      retry = 1000;
      ws.send(JSON.stringify({ type: "sub", players: null }));
    };
    ws.onmessage = function (ev) {
      if (typeof ev.data !== "string") return onFrame(ev.data);
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === "cams") {
        list = m.list || [];
        delayMs = m.delayMs || 0;
        for (var id in cams) if (!list.some(function (p) { return p.steamId === id && p.onAir; })) clear(cams[id]);
        emit("change");
      } else if (m.type === "observed") {
        observed = m.steamId || null;
        emit("observed");
      }
    };
    ws.onclose = function () {
      ws = null;
      list = [];
      for (var id in cams) clear(cams[id]);
      emit("change");
      setTimeout(connect, retry);
      retry = Math.min(10000, retry * 2);
    };
  }
  window.MatchframeCams = {
    /** The canvas a player's cam is drawn into (transparent while off air). */
    canvas: function (steamId) { return cam(steamId).canvas; },
    /** A MediaStream of that canvas, for a video element. */
    stream: function (steamId) {
      var c = cam(steamId);
      if (!c.stream) c.stream = c.canvas.captureStream(30);
      return c.stream;
    },
    onAir: function (steamId) { return list.some(function (p) { return p.steamId === steamId && p.onAir; }); },
    list: function () { return list.slice(); },
    observed: function () { return observed; },
    delayMs: function () { return delayMs; },
    on: function (ev, fn) { if (handlers[ev]) handlers[ev].push(fn); },
    off: function (ev, fn) { if (handlers[ev]) handlers[ev] = handlers[ev].filter(function (f) { return f !== fn; }); },
    /** For checks: when a cam last drew a frame (performance.now()). */
    lastFrameAt: function (steamId) { return cams[steamId] ? cams[steamId].frameAt : 0; }
  };
  connect();
})();
`;

export const LHM_CAMS_JS = String.raw`(function () {
  "use strict";
  var Real = window.RTCPeerConnection;
  if (!Real || window.__mfLhmCams) return;
  window.__mfLhmCams = true;
  var MARK = "a=x-matchframe-cam:";
  var open = {};
  var offAirSince = {};
  var HANDLERS = ["onicecandidate", "oniceconnectionstatechange", "onicegatheringstatechange", "onconnectionstatechange", "onsignalingstatechange", "ontrack", "ondatachannel", "onnegotiationneeded", "onicecandidateerror"];
  var ANSWER = "v=0\r\no=matchframe 0 0 IN IP4 127.0.0.1\r\ns=matchframe-cam\r\nt=0 0\r\n";

  function Pc(config) {
    this._config = config;
    this._real = null;
    this._fake = null;
    this._h = {};
    this._l = {};
  }
  HANDLERS.forEach(function (name) {
    Object.defineProperty(Pc.prototype, name, {
      get: function () { return this._real ? this._real[name] : this._h[name] || null; },
      set: function (fn) {
        this._h[name] = fn;
        if (this._real) this._real[name] = fn;
      }
    });
  });
  function realGetter(name, fake) {
    Object.defineProperty(Pc.prototype, name, {
      get: function () {
        if (this._fake) return fake(this._fake);
        return this._real ? this._real[name] : name.indexOf("State") >= 0 ? (name === "signalingState" ? "stable" : "new") : null;
      }
    });
  }
  realGetter("localDescription", function (f) { return f.local; });
  realGetter("remoteDescription", function (f) { return f.remote; });
  realGetter("currentLocalDescription", function (f) { return f.local; });
  realGetter("currentRemoteDescription", function (f) { return f.remote; });
  realGetter("signalingState", function (f) { return f.closed ? "closed" : f.local ? "stable" : "have-remote-offer"; });
  realGetter("iceConnectionState", function (f) { return f.conn === "failed" ? "failed" : f.closed ? "closed" : "new"; });
  realGetter("iceGatheringState", function (f) { return f.local ? "complete" : "new"; });
  realGetter("connectionState", function (f) { return f.conn; });
  realGetter("sctp", function () { return null; });
  // Undefined (not null) as in Chrome: simple-peer calls .catch on it when it is an object.
  Object.defineProperty(Pc.prototype, "peerIdentity", { get: function () { return this._real ? this._real.peerIdentity : undefined; } });

  Pc.prototype._ensureReal = function () {
    if (!this._real) {
      this._real = new Real(this._config);
      for (var k in this._h) this._real[k] = this._h[k];
      for (var t in this._l) for (var i = 0; i < this._l[t].length; i++) this._real.addEventListener(t, this._l[t][i]);
    }
    return this._real;
  };
  Pc.prototype._fire = function (type, ev) {
    var h = this._h["on" + type];
    if (h) try { h.call(this, ev); } catch (e) { /* the HUD's handler */ }
    var ls = (this._l[type] || []).slice();
    for (var i = 0; i < ls.length; i++) try { ls[i].call(this, ev); } catch (e) { /* the HUD's listener */ }
  };
  Pc.prototype.addEventListener = function (type, fn) {
    (this._l[type] = this._l[type] || []).push(fn);
    if (this._real) this._real.addEventListener(type, fn);
  };
  Pc.prototype.removeEventListener = function (type, fn) {
    this._l[type] = (this._l[type] || []).filter(function (f) { return f !== fn; });
    if (this._real) this._real.removeEventListener(type, fn);
  };
  Pc.prototype.setRemoteDescription = function (desc) {
    if (!this._real && !this._fake && desc && typeof desc.sdp === "string" && desc.sdp.indexOf(MARK) >= 0) {
      var steamId = desc.sdp.slice(desc.sdp.indexOf(MARK) + MARK.length).split(/\s/)[0];
      this._fake = { steamId: steamId, remote: { type: desc.type, sdp: desc.sdp }, local: null, conn: "new", closed: false };
      (open[steamId] = open[steamId] || []).push(this);
      return Promise.resolve();
    }
    return this._ensureReal().setRemoteDescription(desc);
  };
  Pc.prototype.createAnswer = function (o) {
    if (this._fake) return Promise.resolve({ type: "answer", sdp: ANSWER });
    return this._ensureReal().createAnswer(o);
  };
  Pc.prototype.setLocalDescription = function (d) {
    var self = this;
    if (!this._fake) return this._ensureReal().setLocalDescription(d);
    this._fake.local = d && d.sdp ? { type: d.type, sdp: d.sdp } : { type: "answer", sdp: ANSWER };
    // As a real connection would: gathering complete, then the cam's track.
    setTimeout(function () {
      if (self._fake.closed) return;
      self._fire("icecandidate", { candidate: null });
      setTimeout(function () {
        if (self._fake.closed || !window.MatchframeCams) return;
        var stream = window.MatchframeCams.stream(self._fake.steamId);
        var track = stream.getVideoTracks()[0];
        self._fire("track", { track: track, streams: [stream], receiver: { track: track }, transceiver: {} });
      }, 0);
    }, 0);
    return Promise.resolve();
  };
  Pc.prototype.addIceCandidate = function (c) {
    if (this._fake) return Promise.resolve();
    return this._ensureReal().addIceCandidate(c);
  };
  Pc.prototype.getTransceivers = function () { return this._fake ? [] : this._ensureReal().getTransceivers(); };
  Pc.prototype.getSenders = function () { return this._fake ? [] : this._ensureReal().getSenders(); };
  Pc.prototype.getReceivers = function () { return this._fake ? [] : this._ensureReal().getReceivers(); };
  Pc.prototype.getStats = function (s) { return this._fake ? Promise.resolve(new Map()) : this._ensureReal().getStats(s); };
  Pc.prototype.getConfiguration = function () { return this._fake ? this._config || {} : this._ensureReal().getConfiguration(); };
  Pc.prototype.close = function () {
    if (this._fake) {
      var f = this._fake;
      f.closed = true;
      open[f.steamId] = (open[f.steamId] || []).filter(function (p) { return p._fake !== f; });
      return;
    }
    if (this._real) this._real.close();
  };
  ["createOffer", "createDataChannel", "addTrack", "removeTrack", "addTransceiver", "setConfiguration", "restartIce", "dispatchEvent"].forEach(function (m) {
    Pc.prototype[m] = function () {
      var r = this._ensureReal();
      return r[m].apply(r, arguments);
    };
  });
  Pc.generateCertificate = Real.generateCertificate ? Real.generateCertificate.bind(Real) : undefined;
  window.RTCPeerConnection = Pc;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Pc;

  // A cam off air for more than a moment: its connections end (the HUD shows the avatar again and
  // takes the next offer when the cam is back).
  function check() {
    var mc = window.MatchframeCams;
    if (!mc) return;
    var now = Date.now();
    for (var id in open) {
      if (!open[id].length) continue;
      if (mc.onAir(id)) {
        delete offAirSince[id];
        continue;
      }
      if (!offAirSince[id]) offAirSince[id] = now;
      if (now - offAirSince[id] < 1500) continue;
      var pcs = open[id].slice();
      open[id] = [];
      delete offAirSince[id];
      for (var i = 0; i < pcs.length; i++) {
        pcs[i]._fake.conn = "failed";
        pcs[i]._fire("connectionstatechange", {});
        pcs[i]._fire("iceconnectionstatechange", {});
      }
    }
  }
  setInterval(check, 500);
})();
`;

/** The OBS cam pages: the observed player's cam, or one player's, filling the page (transparent without one). */
export const CAM_PAGE_JS = String.raw`(function () {
  "use strict";
  var fixed = document.body.getAttribute("data-player") || "";
  var holder = document.getElementById("mf-cam");
  var current = null;
  function show() {
    var mc = window.MatchframeCams;
    if (!mc) return;
    var id = fixed || mc.observed();
    var on = !!id && mc.onAir(id);
    if (id !== current) {
      current = id;
      holder.innerHTML = "";
      if (id) holder.appendChild(mc.canvas(id));
    }
    holder.className = on ? "on" : "";
  }
  function start() {
    if (!window.MatchframeCams) return setTimeout(start, 50);
    window.MatchframeCams.on("change", show);
    window.MatchframeCams.on("observed", show);
    show();
  }
  start();
})();
`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function camPage(opts: { title: string; player: string | null }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(opts.title)} - Matchframe player cam</title>
<style>
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
#mf-cam { position: absolute; inset: 0; opacity: 0; transition: opacity 0.25s ease; }
#mf-cam.on { opacity: 1; }
#mf-cam canvas { width: 100%; height: 100%; object-fit: cover; display: block; }
</style>
</head>
<body data-player="${esc(opts.player ?? "")}">
<div id="mf-cam"></div>
<script src="/hud-runtime/cams.js"></script>
<script src="/hud-runtime/cam-page.js"></script>
</body>
</html>
`;
}

/** An LHM-format HUD's HTML with the cam scripts first, so its own scripts see them. */
export function injectLhmCams(html: string): string {
  const tags = '<script src="/hud-runtime/cams.js"></script><script src="/hud-runtime/lhm-cams.js"></script>';
  // In <head>; without one, after <html> or the doctype (never before the doctype: quirks mode).
  const at = /<head(\s[^>]*)?>/i.exec(html) ?? /<html(\s[^>]*)?>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);
  if (at) return html.slice(0, at.index + at[0].length) + tags + html.slice(at.index + at[0].length);
  return tags + html;
}
