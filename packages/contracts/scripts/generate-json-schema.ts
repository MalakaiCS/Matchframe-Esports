/**
 * Generates JSON Schema files for the public contracts into packages/contracts/schema/.
 * Run with: pnpm schemas
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import * as C from "../src/index.ts";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "schema");
mkdirSync(outDir, { recursive: true });

const schemas: Record<string, z.ZodType> = {
  SourceCapabilities: C.SourceCapabilities,
  MatchState: C.MatchState,
  UtilityItem: C.UtilityItem,
  CommandContext: C.CommandContext,
  CommandResult: C.CommandResult,
  ObserverCommand: C.ObserverCommand,
  ObservedCameraState: C.ObservedCameraState,
  DirectorDecision: C.DirectorDecision,
  MapPack: C.MapPack,
  CameraRecord: C.CameraRecord,
  HudManifest: C.HudManifest,
  Team: C.Team,
  Player: C.Player,
  Match: C.Match,
  EventRecord: C.EventRecord,
  EventStage: C.EventStage,
  VetoDecision: C.VetoDecision,
};

for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
  writeFileSync(join(outDir, `${name}.schema.json`), JSON.stringify(json, null, 2) + "\n");
}
console.log(`Wrote ${Object.keys(schemas).length} schemas to ${outDir}`);
