import { existsSync, statSync } from "node:fs";
import { z } from "zod";
import { HudVariant } from "@matchframe/contracts";
import type { Engine } from "../app.ts";
import { PACKAGE_LIMITS, readArchive, readDirectory } from "../hud/packages.ts";
import { OutputDraft } from "../hud/outputs.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";

export function registerHudRoutes(r: Router, e: Engine): void {
  const overlayBase = () => `http://127.0.0.1:${e.cfg.overlayPort}`;

  r.get("/api/v1/hud/packages", { permission: "metadata.read" }, () => e.hudPackages.list().map((p) => ({ ...p, installDir: p.classification === "builtin" ? "[app]" : "[data]/huds", verify: e.hudPackages.verify(p.id) })));
  /** Import an archive (raw zip body). A failed import never affects the installed version. */
  r.post("/api/v1/hud/packages/import", { permission: "hud.publish", maxBodyBytes: PACKAGE_LIMITS.maxTotalBytes }, (req) => {
    if (req.rawBody.length === 0) throw new HttpError(400, "send the package archive as the request body", "empty");
    const files = readArchive(new Uint8Array(req.rawBody));
    const pkg = e.hudPackages.install(files);
    e.audit.record(req.principal!.label, "hud.package.import", pkg.id, { version: pkg.manifest.version, files: Object.keys(pkg.checksums).length });
    return pkg;
  });
  r.post("/api/v1/hud/packages/import-directory", { permission: "hud.publish", body: z.object({ path: z.string() }) }, (req) => {
    if (!existsSync(req.body.path) || !statSync(req.body.path).isDirectory()) throw new HttpError(400, "directory not found", "not_found");
    const pkg = e.hudPackages.install(readDirectory(req.body.path));
    e.audit.record(req.principal!.label, "hud.package.import", pkg.id, { version: pkg.manifest.version });
    return pkg;
  });
  r.post("/api/v1/hud/packages/:id/rollback", { permission: "hud.publish" }, (req) => {
    const pkg = e.hudPackages.rollback(req.params.id!);
    e.audit.record(req.principal!.label, "hud.package.rollback", pkg.id, { version: pkg.manifest.version });
    return pkg;
  });
  r.delete("/api/v1/hud/packages/:id", { permission: "hud.publish" }, (req) => {
    const inUse = e.outputs.list().filter((o) => o.published?.data.packageId === req.params.id);
    if (inUse.length > 0) throw new HttpError(409, `package is used by published outputs: ${inUse.map((o) => o.draft.outputId).join(", ")}`, "in_use");
    e.hudPackages.remove(req.params.id!);
    e.audit.record(req.principal!.label, "hud.package.remove", req.params.id!);
    return { removed: true };
  });

  r.get("/api/v1/hud/outputs", { permission: "metadata.read" }, () =>
    e.outputs.list().map((o) => ({ ...o, url: e.outputs.url(overlayBase(), o.draft.outputId), revisions: e.outputs.revisions(o.draft.outputId) })),
  );
  r.post("/api/v1/hud/outputs", { permission: "hud.publish", body: OutputDraft.partial().extend({ outputId: z.string().regex(/^[a-z0-9-]{2,40}$/), name: z.string().min(1) }) }, (req) => {
    const d = e.outputs.drafts.create({ packageId: "matchframe-default", variant: "live", presetId: "classic", matchId: null, timelineProfile: "live", delayMs: 0, profile: "program", publishedRevision: null, settings: {}, ...req.body, id: req.body.outputId });
    e.audit.record(req.principal!.label, "hud.output.create", d.id);
    return d.data;
  });
  /** Draft edits never affect what is on air until published. */
  r.patch("/api/v1/hud/outputs/:id", { permission: "hud.publish" }, (req) => {
    const body = req.body as Record<string, unknown>;
    if (body.packageId && !e.hudPackages.get(String(body.packageId))) throw new HttpError(400, "unknown HUD package", "bad_package");
    if (body.variant) HudVariant.parse(body.variant);
    const d = e.outputs.drafts.update(req.params.id!, body);
    e.audit.record(req.principal!.label, "hud.output.draft", d.id, body);
    return d.data;
  });
  r.post("/api/v1/hud/outputs/:id/publish", { permission: "hud.publish" }, (req) => {
    const pub = e.outputs.publish(req.params.id!, req.principal!.label);
    e.audit.record(req.principal!.label, "hud.output.publish", req.params.id!, { revision: pub.revision });
    return pub;
  });
  r.post("/api/v1/hud/outputs/:id/rollback", { permission: "hud.publish", body: z.object({ revision: z.number().int().positive() }) }, (req) => {
    const pub = e.outputs.rollback(req.params.id!, req.body.revision, req.principal!.label);
    e.audit.record(req.principal!.label, "hud.output.rollback", req.params.id!, { to: req.body.revision, revision: pub.revision });
    return pub;
  });
  r.post("/api/v1/hud/outputs/:id/rotate-token", { permission: "hud.publish" }, (req) => {
    e.outputs.rotateToken(req.params.id!);
    e.audit.record(req.principal!.label, "hud.output.rotate_token", req.params.id!);
    return { url: e.outputs.url(overlayBase(), req.params.id!) };
  });
  r.get("/api/v1/hud/outputs/:id/url", { permission: "metadata.read" }, (req) => ({ url: e.outputs.url(overlayBase(), req.params.id!, req.query.get("variant") ?? undefined) }));
  /** Preview of the public projection for an output (what the browser source receives). */
  r.get("/api/v1/hud/outputs/:id/state", { permission: "state.read" }, (req) => e.hudState(req.params.id!, req.query.get("variant") ?? undefined));
}
