// Connection settings page of the Matchframe program (no framework; talks only to the preload bridge).
(function () {
  "use strict";
  const bridge = window.matchframe && window.matchframe.connection;
  const $ = (id) => document.getElementById(id);
  const form = $("form");
  const remote = $("remote");
  const status = $("status");
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
    setStatus("This page only works inside the Matchframe program.", "bad");
    $("save").disabled = true;
    return;
  }
  bridge.get().then((c) => {
    if (!c) return;
    if (c.mode === "remote") {
      form.querySelector('input[value="remote"]').checked = true;
      $("url").value = c.url || "";
      if (c.hasToken) $("token").placeholder = "Saved (leave empty to keep it)";
    }
    $("version").textContent = "Matchframe " + c.version;
    sync();
  });
  $("test").addEventListener("click", async () => {
    setStatus("Testing…");
    const r = await bridge.test($("url").value, $("token").value);
    if (r.ok) setStatus("Connected to " + r.origin + " as " + r.role + (r.label ? " (" + r.label + ")" : "") + ".", "ok");
    else setStatus(r.message, "bad");
  });
  $("cancel").addEventListener("click", () => bridge.cancel());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (mode() === "local") {
      setStatus("Starting the engine on this computer…");
      await bridge.save({ mode: "local" });
      return;
    }
    setStatus("Testing…");
    const r = await bridge.test($("url").value, $("token").value);
    if (!r.ok) return setStatus(r.message, "bad");
    setStatus("Connecting…", "ok");
    const saved = await bridge.save({ mode: "remote", url: $("url").value, token: $("token").value });
    if (!saved) setStatus("Could not save the connection.", "bad");
  });
})();
