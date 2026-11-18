// Connection settings page of the MatchFrame program (no framework; talks only to the preload bridge).
(function () {
  "use strict";
  const bridge = window.matchframe && window.matchframe.connection;
  const $ = (id) => document.getElementById(id);
  const form = $("form");
  const remote = $("remote");
  const status = $("status");
  // The page's text in the language chosen in Settings → General → Language (sent by the program); English until then.
  let strings = {};
  const s = (key, fallback, vars) => {
    let text = strings[key] || fallback;
    if (vars) for (const k of Object.keys(vars)) text = text.split("{" + k + "}").join(String(vars[k]));
    return text;
  };
  // Rich text with <em> and <code> only, built as DOM nodes (never innerHTML).
  const setRich = (el, text) => {
    el.textContent = "";
    const re = /<(em|code)>([\s\S]*?)<\/\1>/g;
    let last = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
      const tag = document.createElement(m[1]);
      tag.textContent = m[2];
      el.appendChild(tag);
      last = m.index + m[0].length;
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
  };
  const translatePage = (lang) => {
    if (lang) document.documentElement.lang = lang;
    if (strings.pageTitle) document.title = strings.pageTitle;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const v = strings[el.getAttribute("data-i18n")];
      if (v) el.textContent = v;
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const v = strings[el.getAttribute("data-i18n-placeholder")];
      if (v) el.placeholder = v;
    });
    document.querySelectorAll("[data-i18n-rich]").forEach((el) => {
      const v = strings[el.getAttribute("data-i18n-rich")];
      if (v) setRich(el, v);
    });
  };
  const setStatus = (text, tone) => {
    status.textContent = text;
    status.className = "status" + (tone ? " " + tone : "");
  };
  const mode = () => form.querySelector('input[name="mode"]:checked').value;
  const sync = () => {
    remote.disabled = mode() !== "remote";
  };
  form.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", sync));
  if (!bridge) {
    setStatus("This page only works inside the MatchFrame program.", "bad");
    $("save").disabled = true;
    return;
  }
  bridge.get().then((c) => {
    if (!c) return;
    strings = c.strings || {};
    translatePage(c.lang);
    if (c.mode === "remote") {
      form.querySelector('input[value="remote"]').checked = true;
      $("url").value = c.url || "";
      if (c.hasToken) $("token").placeholder = s("savedToken", "Saved (leave empty to keep it)");
    }
    $("version").textContent = "MatchFrame " + c.version;
    sync();
  });
  const connected = (r) => (r.label ? s("connectedAsLabel", "Connected to {origin} as {role} ({label}).", r) : s("connectedAs", "Connected to {origin} as {role}.", r));
  $("test").addEventListener("click", async () => {
    setStatus(s("testing", "Testing…"));
    const r = await bridge.test($("url").value, $("token").value);
    if (r.ok) setStatus(connected(r), "ok");
    else setStatus(r.message, "bad");
  });
  $("cancel").addEventListener("click", () => bridge.cancel());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (mode() === "local") {
      setStatus(s("startingLocal", "Starting the engine on this computer…"));
      await bridge.save({ mode: "local" });
      return;
    }
    setStatus(s("testing", "Testing…"));
    const r = await bridge.test($("url").value, $("token").value);
    if (!r.ok) return setStatus(r.message, "bad");
    setStatus(s("connecting", "Connecting…"), "ok");
    const saved = await bridge.save({ mode: "remote", url: $("url").value, token: $("token").value });
    if (!saved) setStatus(s("saveFailed", "Could not save the connection."), "bad");
  });
})();
