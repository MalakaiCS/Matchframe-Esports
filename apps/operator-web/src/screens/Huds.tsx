import { Tabs } from "../components/ui.tsx";
import { usePersistentState } from "../lib/hooks.ts";
import { AnnotationsTab } from "./huds/Annotations.tsx";
import { ComposerTab } from "./huds/Composer.tsx";
import { CuesTab } from "./huds/Cues.tsx";
import { OutputsTab } from "./huds/Outputs.tsx";
import { PackagesTab } from "./huds/Packages.tsx";

type Tab = "outputs" | "packages" | "cues" | "annotations" | "composer";

export function HudsScreen() {
  const [tab, setTab] = usePersistentState<Tab>("hudsTab", "outputs");
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">HUDs &amp; Composer</h1>
      </div>
      <p className="page-intro">Outputs are browser sources with a draft and published revisions: edit the draft, publish when ready, roll back instantly. Cues and annotations go on air immediately.</p>
      <Tabs<Tab>
        label="HUD sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "outputs", label: "Outputs" },
          { id: "packages", label: "Packages" },
          { id: "cues", label: "Cues" },
          { id: "annotations", label: "Annotations" },
          { id: "composer", label: "Composer (preview)" },
        ]}
      />
      {tab === "outputs" ? <OutputsTab /> : null}
      {tab === "packages" ? <PackagesTab /> : null}
      {tab === "cues" ? <CuesTab /> : null}
      {tab === "annotations" ? <AnnotationsTab /> : null}
      {tab === "composer" ? <ComposerTab /> : null}
    </div>
  );
}
