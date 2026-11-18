import type { ReactNode } from "react";
import { Tabs } from "../components/ui.tsx";
import { usePersistentState } from "../lib/hooks.ts";
import "../styles/group-b.css";
import { AnnotationsTab } from "./huds/Annotations.tsx";
import { ComposerTab } from "./huds/Composer.tsx";
import { CuesTab } from "./huds/Cues.tsx";
import { OutputsTab } from "./huds/Outputs.tsx";
import { PackagesTab } from "./huds/Packages.tsx";
import { t } from "../i18n/index.ts";

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
    <HudPage title={t("huds.broadcastOutputs")} intro={t("huds.namedBrowserSourceOutputsWith")}>
      <Tabs
        label={t("huds.broadcastOutputSections")}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "outputs", label: t("huds.outputs") },
          { id: "packages", label: t("huds.packages") },
        ]}
      />
      {tab === "packages" ? <PackagesTab /> : <OutputsTab />}
    </HudPage>
  );
}

export function HudCuesScreen() {
  return (
    <HudPage title={t("huds.cues")} intro={t("huds.lowerThirdsCasterCardsAnd2")}>
      <CuesTab />
    </HudPage>
  );
}

export function HudAnnotationsScreen() {
  return (
    <HudPage title={t("huds.annotations")} intro={t("huds.telestratorDrawingsOnTheBroadcast")}>
      <AnnotationsTab />
    </HudPage>
  );
}

export function HudComposerScreen() {
  return (
    <HudPage title={t("huds.composer")} intro={t("huds.arrangeTheBuiltInHud")}>
      <ComposerTab />
    </HudPage>
  );
}
