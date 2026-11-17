import { Icon } from "../../components/icons.tsx";
import type { IconName } from "../../components/icons.tsx";
import { CheckList, CtaBand, DownloadButton, Screenshot, SectionHead } from "../../components/marketing.tsx";
import type { ShotName } from "../../components/marketing.tsx";
import { StageAnatomy, StageDemo } from "../../components/stage.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";

/** The HUD's states, as rendered from its demo scenes. */
const STATES: { name: ShotName; title: string; text: string; alt: string }[] = [
  { name: "stage-timeout", title: "Timeout scoreboard", text: "In tactical timeouts and tech or match pauses: equipment value, loss bonus, timeouts left and every player's loadout, with your sponsor in the middle.", alt: "The Stage HUD in a tactical timeout: a full-width scoreboard along the bottom with each team's equipment value, loss bonus and timeouts left, ten player rows with guns, utility and money, a sample sponsor in the middle and the timeout countdown on the right." },
  { name: "stage-mvp", title: "Round MVP card", text: "Last round's key player, with kills, damage and health, grows out of their card 5 seconds into freeze time and goes back a few seconds into the round.", alt: "The Stage HUD with the round MVP card: a tall card in the left team's list showing ROUND MVP, the player's name, picture, round 17 stats with 2 kills and 200 damage, and health." },
  { name: "stage-bomb", title: "Bomb planted", text: "The clock becomes the fuse, in red, with a fuse bar under the score bar; the bomb shows on the minimap.", alt: "The Stage HUD after the bomb is planted: the score bar shows the fuse at 0:31 in red with a bar under it, three players alive on each side and two grey cards for fallen players on each side." },
  { name: "stage-pause", title: "Pause", text: "A technical or match pause shows the pause mark on the score bar and brings up the full scoreboard.", alt: "The Stage HUD in a technical pause: the pause mark in the middle of the score bar and the full-width scoreboard along the bottom." },
];

const SETTINGS: [string, string][] = [
  ["Panel colour", "Royal blue or dark navy for the score bar, event line, series strip, scoreboard header and killfeed."],
  ["CT and T colours", "The cards' side colours, unless a team has its own colour."],
  ["Event line", "Your own text left and right of the line over the score bar, or the event's name and the match's stage and title."],
  ["Trophy", "Upload a trophy in HUD images and it sits in the middle of the event line."],
  ["Pause scoreboard", "On: the full-width scoreboard in timeouts and pauses. Off: the cards stay."],
  ["Round MVP", "On or off, and how many seconds into the round it goes (5 to 10, 8 by default)."],
  ["Team names", "Full names or short tags over the cards."],
  ["Elements", "Series strip, minimap, killfeed (1 to 5 rows), sponsor slots, players alive, the observed player and money, each on or off."],
];

const WITH: { icon: IconName; title: string; text: string }[] = [
  { icon: "hud", title: "OBS or over the game", text: "Add it to OBS as a 1920×1080 browser source, or show it as a transparent window over CS2 on this computer." },
  { icon: "video", title: "Player cams", text: "With player cams on air, the observed player's camera fills the space between the teams." },
  { icon: "layers", title: "Your pictures", text: "Team logos and colours from Teams, player pictures, default pictures, and an icon pack you load yourself." },
  { icon: "sponsor", title: "Sponsors", text: "Your sponsors in the top slot and the scoreboard, in safe windows, with each display logged." },
  { icon: "replay", title: "Replay graphic", text: "A REPLAY tag and a lower third with the player, weapon and play over every replay, in the same style." },
  { icon: "cpu", title: "Low-spec mode", text: "On one PC it runs at 30 frames a second with lighter effects, and the MVP card uses a quick wipe." },
];

export function StageHud() {
  useTitle("Stage HUD", "The Stage HUD: a tournament-stage layout for CS2 broadcasts in MatchFrame's own look, with side-coloured player cards, the round MVP card and a full-width pause scoreboard. Try it live in your browser.");
  return (
    <>
      <header className="page-hero page-hero-stage">
        <div className="wrap">
          <nav aria-label="Breadcrumb" className="crumbs">
            <ol>
              <li>
                <Link to="/features">Features</Link>
              </li>
              <li>
                <Link to="/features/huds">HUDs</Link>
              </li>
            </ol>
          </nav>
          <p className="eyebrow">Stage HUD</p>
          <h1 tabIndex={-1} data-page-heading>
            A tournament-stage layout for your CS2 broadcast
          </h1>
          <p className="page-hero-lead">Side-coloured player cards, the round MVP card, a full-width scoreboard in timeouts and a trophy on the event line, in MatchFrame's own look. It comes with the program, on every plan, Free included.</p>
          <div className="page-hero-actions">
            <DownloadButton />
            <a href="#stage-demo" className="btn btn-on-dark btn-lg">
              <Icon name="play" size={18} /> Try the live demo
            </a>
          </div>
        </div>
      </header>

      <section className="section section-stage" aria-labelledby="demo-title">
        <div className="wrap">
          <SectionHead id="demo-title" eyebrow="Live demo" title="The real HUD, running in your browser" lead="Switch scenes: the HUD animates from one to the next, just as it does on air." center />
          <StageDemo />
        </div>
      </section>

      <section className="section" aria-labelledby="anatomy-title">
        <div className="wrap">
          <SectionHead id="anatomy-title" eyebrow="What's on screen" title="Everything the viewer needs, where they expect it" center />
          <StageAnatomy />
        </div>
      </section>

      <section className="section section-alt" aria-labelledby="states-title">
        <div className="wrap">
          <SectionHead id="states-title" eyebrow="Through the round" title="It changes with the match" lead="Freeze time keeps the cards. Timeouts and pauses bring up the scoreboard. The round's key player gets their moment." center />
          <ul className="state-grid">
            {STATES.map((s) => (
              <li key={s.name} className="state">
                <Screenshot name={s.name} alt={s.alt} sizes="(min-width: 1100px) 540px, (min-width: 720px) 45vw, 100vw" />
                <h3 className="feature-title">{s.title}</h3>
                <p className="feature-text">{s.text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section" aria-labelledby="settings-title">
        <div className="wrap settings-layout">
          <div>
            <SectionHead id="settings-title" eyebrow="Make it yours" title="Settings in the HUD Library" lead="Set them per HUD in the program's HUD Library. Teams' own colours and logos come from Teams." />
            <div className="panel-compare">
              <figure>
                <img src="/images/stage-panel-blue-550.webp" width={550} height={250} alt="The score bar and event line on royal-blue panels." loading="lazy" decoding="async" />
                <figcaption>Royal blue</figcaption>
              </figure>
              <figure>
                <img src="/images/stage-panel-navy-550.webp" width={550} height={250} alt="The same score bar and event line on dark-navy panels." loading="lazy" decoding="async" />
                <figcaption>Dark navy</figcaption>
              </figure>
            </div>
          </div>
          <dl className="spec-list settings-list">
            {SETTINGS.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="section section-alt" aria-labelledby="with-title">
        <div className="wrap">
          <SectionHead id="with-title" eyebrow="Works with" title="Part of the whole production" center />
          <ul className="feature-grid cols-3">
            {WITH.map((w) => (
              <li key={w.title} className="feature">
                <span className="feature-icon">
                  <Icon name={w.icon} />
                </span>
                <h3 className="feature-title">{w.title}</h3>
                <p className="feature-text">{w.text}</p>
              </li>
            ))}
          </ul>
          <div className="stage-more">
            <p>Prefer another look? Vector, Lineup, the MatchFrame Broadcast HUD and the Pro CS2 HUD come with the program too, and you can import hud.json HUDs.</p>
            <CheckList items={["Every HUD on every plan, Free included", "No account needed for HUDs", "Fictional names and a sample sponsor in the demo only"]} />
            <Link to="/features/huds" className="link-arrow">
              All the HUDs <Icon name="arrow" size={18} />
            </Link>
          </div>
        </div>
      </section>

      <CtaBand title="Put your match on the stage" text="Download the program, pick the Stage HUD in the HUD Library and rehearse with the built-in simulation.">
        <DownloadButton />
        <Link to="/pricing" className="btn btn-on-dark btn-lg">
          See plans
        </Link>
      </CtaBand>
    </>
  );
}
