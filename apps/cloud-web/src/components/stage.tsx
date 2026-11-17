import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";

/**
 * The Stage HUD on the website: the live demo (the real HUD from apps/hud-designs, copied to
 * /demo/stage/ by the site build, running its own demo scenes) and the labelled picture of what's on
 * screen. Fictional teams and players, a sample sponsor and a made-up minimap: nothing third-party.
 */

/** The HUD's demo extras: sample player pictures, the made-up minimap, team emblems, a trophy and the sample sponsor. */
const DEMO_QUERY = "art=1&radar=1&logo=1&trophy=1&sponsor=1";

export interface StageScene {
  /** The HUD's `?demo=` scene (apps/hud-designs/src/shared/demo.ts). */
  id: string;
  label: string;
  text: string;
}

export const STAGE_SCENES: StageScene[] = [
  { id: "kill", label: "Live round", text: "Five cards a side in the side's colour, with health, armour, guns, utility and money. The observed player's cam and stats sit between them, with the killfeed top right and the minimap top left." },
  { id: "bomb", label: "Bomb planted", text: "The round clock becomes the bomb's fuse, with a fuse bar under the score bar. The bomb shows on the minimap and fallen players' cards turn grey." },
  { id: "mvpfreeze", label: "Round MVP", text: "Freeze time of the next round. After 5 seconds, last round's key player's card grows into the round MVP card. It shrinks back a few seconds into the round (5 to 10, you choose)." },
  { id: "timeout", label: "Timeout scoreboard", text: "In a tactical timeout the cards make way for a full-width scoreboard: equipment value, loss bonus, timeouts left, every player's guns, utility and money, and your sponsor in the middle." },
  { id: "pause", label: "Pause", text: "In a technical or match pause the score bar shows the pause mark and the same full-width scoreboard comes up." },
];

export const stageDemoUrl = (scene: string, lowSpec = false) => `/demo/stage/index.html?demo=${encodeURIComponent(scene)}&${DEMO_QUERY}${lowSpec ? "&lowspec=1" : ""}`;

const prefersReducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** The HUD page's own hook for switching scenes (useHud.ts: `window.__mfDemo`), same origin only. */
type DemoWindow = Window & { __mfDemo?: (scene: string) => void };

/**
 * The live Stage HUD in a 16:9 frame: the HUD scales its 1920×1080 stage to the frame by itself.
 * The frame loads only when it comes near the screen; until then (and while it loads) the render of
 * the same scene stands in. Scene buttons switch the running HUD, so its animations play. With
 * reduced motion the HUD runs in its low-spec mode (quick wipes, no looping effects).
 */
export function StageDemo({ id = "stage-demo" }: { id?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [near, setNear] = useState(false);
  const [ready, setReady] = useState(false);
  const [scene, setScene] = useState(STAGE_SCENES[0]!.id);
  const [lowSpec] = useState(prefersReducedMotion);
  const [src, setSrc] = useState(() => stageDemoUrl(STAGE_SCENES[0]!.id, lowSpec));

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setNear(true);
        io.disconnect();
      }
    }, { rootMargin: "400px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const choose = (next: string) => {
    setScene(next);
    let switched = false;
    try {
      const w = frame.current?.contentWindow as DemoWindow | null | undefined;
      if (ready && typeof w?.__mfDemo === "function") {
        w.__mfDemo(next);
        switched = true;
      }
    } catch {
      // Not the same origin (or not loaded): load the scene's page instead.
    }
    if (!switched) {
      setReady(false);
      setSrc(stageDemoUrl(next, lowSpec));
    }
  };

  const current = STAGE_SCENES.find((s) => s.id === scene) ?? STAGE_SCENES[0]!;
  return (
    <div className="stage-demo" id={id}>
      <div className="stage-demo-scenes" role="group" aria-label="Stage HUD demo scene">
        {STAGE_SCENES.map((s) => (
          <button key={s.id} type="button" className="stage-scene" aria-pressed={s.id === scene} onClick={() => choose(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      <div ref={box} className={`stage-demo-screen${ready ? " is-ready" : ""}`}>
        <img className="stage-demo-poster" src="/images/stage-live-1600.webp" srcSet="/images/stage-live-960.webp 960w, /images/stage-live-1600.webp 1600w" sizes="(min-width: 1220px) 1160px, 100vw" alt="" aria-hidden="true" loading="lazy" decoding="async" width={1600} height={900} />
        {near && <iframe ref={frame} src={src} title={`Stage HUD live demo: ${current.label}`} loading="lazy" tabIndex={-1} onLoad={() => setReady(true)} />}
      </div>
      <div className="stage-demo-foot">
        <p className="stage-demo-text" aria-live="polite">
          <strong>{current.label}.</strong> {current.text}
        </p>
        <a className="link-arrow small" href={stageDemoUrl(scene, lowSpec)} target="_blank" rel="noopener">
          Open the demo full size <span className="visually-hidden">(opens in a new tab)</span>
          <Icon name="arrow" size={16} />
        </a>
      </div>
      <p className="stage-demo-note">The real Stage HUD running in your browser with fictional teams, a sample sponsor and a made-up minimap. In the program it draws your match from the game data.</p>
    </div>
  );
}

/** What's on screen, numbered over the render (positions in % of the 1920×1080 stage). */
export const STAGE_PARTS: { n: number; x: number; y: number; title: string; text: string }[] = [
  { n: 1, x: 19.2, y: 3.8, title: "Series strip", text: "Every map of the series with its score and who picked it, over the minimap." },
  { n: 2, x: 23.4, y: 23, title: "Minimap", text: "Players by slot number, the bomb and utility, in the side colours." },
  { n: 3, x: 38.2, y: 3.9, title: "Event line and trophy", text: "Your event and stage titles, with a trophy image in the middle if you add one." },
  { n: 4, x: 38.2, y: 9.6, title: "Score bar", text: "Team emblems, the score, the round and its clock, which turns into the bomb's fuse." },
  { n: 5, x: 44.8, y: 15.8, title: "Players alive", text: "How many are left on each side, in the side colours." },
  { n: 6, x: 81.6, y: 6.2, title: "Sponsor slot", text: "Your scheduled sponsor. Nothing shows when none is booked." },
  { n: 7, x: 88.2, y: 14.9, title: "Killfeed", text: "Up to five kills, with headshots, assists and blind kills." },
  { n: 8, x: 18.6, y: 77.6, title: "Player cards", text: "Five cards a side: name, picture, main gun, health, armour, kit, utility, kills, deaths and money." },
  { n: 9, x: 40.8, y: 88.8, title: "Observed player", text: "The player's cam when player cams are on air (or their picture), with their stats." },
];

/** The labelled picture: the render with numbered marks, and the list they refer to. */
export function StageAnatomy() {
  return (
    <div className="anatomy">
      <figure className="anatomy-figure">
        <div className="anatomy-frame">
          <img src="/images/stage-live-1600.webp" srcSet="/images/stage-live-960.webp 960w, /images/stage-live-1600.webp 1600w, /images/stage-live-2400.webp 2400w" sizes="(min-width: 1220px) 1160px, 100vw" alt="The Stage HUD during a live round, with numbered marks on its parts, listed below the picture." width={2400} height={1350} loading="lazy" decoding="async" />
          {STAGE_PARTS.map((p) => (
            <span key={p.n} className="anatomy-mark" style={{ left: `${p.x}%`, top: `${p.y}%` }} aria-hidden="true">
              {p.n}
            </span>
          ))}
        </div>
        <figcaption>Rendered from the Stage HUD's own demo scene: fictional teams and players, a sample sponsor and a made-up minimap.</figcaption>
      </figure>
      <ol className="anatomy-list">
        {STAGE_PARTS.map((p) => (
          <li key={p.n}>
            <span className="anatomy-num" aria-hidden="true">
              {p.n}
            </span>
            <div>
              <strong>{p.title}</strong>
              <span>{p.text}</span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
