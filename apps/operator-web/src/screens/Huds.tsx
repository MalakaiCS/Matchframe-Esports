import type { ReactNode } from "react";
import { Tabs } from "../components/ui.tsx";
import { usePersistentState } from "../lib/hooks.ts";
import "../styles/group-b.css";
import { AnnotationsTab } from "./huds/Annotations.tsx";
import { ComposerTab } from "./huds/Composer.tsx";
import { CuesTab } from "./huds/Cues.tsx";
import { OutputsTab } from "./huds/Outputs.tsx";
import { PackagesTab } from "./huds/Packages.tsx";

/** HUD Library sub-pages (the broadcast tools that existed before the library). */
function HudPage({ title, intro, children }: { title: string; intro: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{title}</h1>
      </div>
      <p className="page-intro">{intro}</p>
      {children}
    </div>
  );
}

export function HudOutputsScreen() {
  const [tab, setTab] = usePersistentState<"outputs" | "packages">("hudOutputsTab", "outputs");
  return (
    <HudPage title="Broadcast outputs" intro="Named browser-source outputs with draft, publish, rollback and delay. Output changes go on air when you publish them.">
      <Tabs
        label="Broadcast output sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "outputs", label: "Outputs" },
          { id: "packages", label: "Packages" },
        ]}
      />
      {tab === "packages" ? <PackagesTab /> : <OutputsTab />}
    </HudPage>
  );
}

export function HudCuesScreen() {
  return (
    <HudPage title="Cues" intro="Lower thirds, caster cards and other short graphics on the broadcast outputs. Cues go on air immediately.">
      <CuesTab />
    </HudPage>
  );
}

export function HudAnnotationsScreen() {
  return (
    <HudPage title="Annotations" intro="Telestrator drawings on the broadcast outputs. Annotations go on air immediately.">
      <AnnotationsTab />
    </HudPage>
  );
}

export function HudComposerScreen() {
  return (
    <HudPage title="Composer" intro="Arrange the built-in HUD layout in an output draft, then publish it from Broadcast outputs.">
      <ComposerTab />
    </HudPage>
  );
}
