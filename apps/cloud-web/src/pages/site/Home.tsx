import { api } from "../../api/index.ts";
import { Icon } from "../../components/icons.tsx";
import type { IconName } from "../../components/icons.tsx";
import { CheckList, CtaBand, DownloadButton, Screenshot, SectionHead, Spotlight } from "../../components/marketing.tsx";
import { PlanCard } from "../../components/PlanCard.tsx";
import { StageDemo } from "../../components/stage.tsx";
import { FaqList, faqById } from "../../content/faq.tsx";
import type { FaqItem } from "../../content/faq.tsx";
import { FEATURES } from "../../content/features.tsx";
import { CURRENT_VERSION } from "../../content/release.ts";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";

const HOME_FAQ = ["need-account", "what-is-an-hour", "updates", "replace-observer"].map(faqById).filter((f): f is FaqItem => !!f);

function PlanTeaser() {
  const plans = useResource("plans", api.plans);
  const list = plans.data?.plans ?? [];
  return (
    <section className="section" aria-labelledby="plans-title">
      <div className="wrap">
        <SectionHead id="plans-title" eyebrow="Pricing" title="Start free. Pay for automation when you need it." lead="Every plan includes the whole program: every HUD, replays, map intros, Team Comms and player cams. Plans differ in auto-director hours, linked computers and team size. No overage charges, ever." center />
        {list.length > 0 && (
          <div className="plan-grid plan-grid-teaser">
            {list.map((p, i) => (
              <PlanCard
                key={p.id}
                plan={p}
                highlight={i === 1}
                badge={i === 1 ? <span className="badge badge-brand">Popular</span> : undefined}
                action={
                  <Link to="/pricing" className={`btn ${i === 1 ? "btn-primary" : "btn-secondary"} btn-block`}>
                    {p.priceMonthlyCents === 0 ? "See what's included" : `See ${p.name} details`}
                  </Link>
                }
              />
            ))}
          </div>
        )}
        <p className="center-text section-foot">
          <Link to="/pricing" className="link-arrow">
            Compare plans and hour packs <Icon name="arrow" size={18} />
          </Link>
        </p>
      </div>
    </section>
  );
}

/** The three ways to set up, from How it works. */
const SETUPS: { icon: IconName; title: string; text: string; to: string }[] = [
  { icon: "cpu", title: "One PC", text: "CS2, OBS and MatchFrame on one computer. Low-spec mode keeps the HUD light while the game runs.", to: "/how-it-works#one-pc" },
  { icon: "replay", title: "Two PCs", text: "Add a replay PC that watches a few seconds behind and films every kill for replays between rounds.", to: "/how-it-works#two-pc" },
  { icon: "network", title: "A crew", text: "Producers, replay and graphics operators connect to the production computer from their own PCs.", to: "/how-it-works#crew" },
];

export function Home() {
  useTitle("", "MatchFrame Esports: broadcast-grade CS2 production for Windows. The Stage HUD and four more HUDs, an Auto Director that cuts before the fight, replays of every kill, map intros and Team Comms, in one program.");
  return (
    <>
      <section className="hero hero-stage" aria-labelledby="home-title">
        <div className="wrap hero-stage-copy">
          <p className="hero-eyebrow">
            <span className="tally-dot" aria-hidden="true" /> Early access · Windows · Counter-Strike 2
          </p>
          <h1 id="home-title" tabIndex={-1} data-page-heading>
            Broadcast-grade CS2 production
          </h1>
          <p className="hero-lead">The Stage HUD, an Auto Director that cuts before the fight and replays of every kill, run from one Windows program.</p>
          <div className="hero-cta">
            <DownloadButton />
            <Link to="/pricing" className="btn btn-on-dark btn-lg">
              See plans
            </Link>
          </div>
          <ul className="hero-points">
            <li>
              <Icon name="check" size={16} /> Free plan, no card needed
            </li>
            <li>
              <Icon name="windows" size={16} /> Windows 10 and 11
            </li>
            <li>
              <Icon name="clock" size={16} /> Version {CURRENT_VERSION}
            </li>
          </ul>
        </div>
        <div className="hero-stage-media">
          <figure className="stage-monitor">
            <div className="stage-monitor-frame">
              <img
                src="/images/stage-live-1600.webp"
                srcSet="/images/stage-live-960.webp 960w, /images/stage-live-1600.webp 1600w, /images/stage-live-2400.webp 2400w"
                sizes="(min-width: 1480px) 1400px, calc(100vw - 32px)"
                width={2400}
                height={1350}
                alt="The Stage HUD during a live round: the series strip and minimap top left, the event line with a trophy and the score bar top centre, a sponsor slot and the killfeed top right, five blue cards bottom left, five gold cards bottom right and the observed player's cam between them."
                fetchPriority="high"
                decoding="async"
              />
            </div>
            <figcaption>
              The Stage HUD, rendered from its own demo scene: fictional teams, a sample sponsor. <Link to="/stage-hud">Explore the Stage HUD</Link>
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="strip" aria-label="Highlights">
        <div className="wrap strip-grid">
          <p>
            <strong>Four HUDs</strong> for OBS or over the game
          </p>
          <p>
            <strong>Auto Director</strong> with manual takeover
          </p>
          <p>
            <strong>Replays</strong> of every kill with a replay PC
          </p>
          <p>
            <strong>Works offline</strong>: only live automation uses hours
          </p>
        </div>
      </section>

      <section className="section section-stage" aria-labelledby="demo-title">
        <div className="wrap">
          <SectionHead id="demo-title" eyebrow="Live demo" title="Try the Stage HUD in your browser" lead="This is the HUD itself, not a video. Switch scenes to see the bomb timer, the round MVP card and the pause scoreboard come in." center />
          <StageDemo />
          <p className="center-text section-foot">
            <Link to="/stage-hud" className="link-arrow link-on-dark">
              What's on screen, and the settings <Icon name="arrow" size={18} />
            </Link>
          </p>
        </div>
      </section>

      <section className="section" aria-labelledby="areas-title">
        <div className="wrap">
          <SectionHead id="areas-title" eyebrow="The program" title="Everything the production desk needs" lead="One program on your production PC brings the broadcast together. This website keeps the account, plan and hours behind it." center />
          <ul className="area-grid">
            {FEATURES.map((f) => (
              <li key={f.slug} className="area">
                <span className="feature-icon">
                  <Icon name={f.icon} />
                </span>
                <h3 className="feature-title">
                  <Link to={`/features/${f.slug}`} className="area-link">
                    {f.title}
                  </Link>
                </h3>
                <p className="feature-text">{f.tagline}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section section-alt" aria-labelledby="inside-title">
        <div className="wrap">
          <SectionHead id="inside-title" eyebrow="Inside the program" title="Real screens, from the program itself" center />
          <div className="spotlights">
            <Spotlight
              id="home-director"
              eyebrow="Auto Director"
              title="An automatic observer you stay in charge of"
              shot={<Screenshot name="console-live-control" alt="Live Control: both simulated teams, the Auto Director on air in Observer & Cinematics with its checks passed, the shot on air and the Observer modes." caption="Live Control. Real screenshot; the match data is simulated." />}
            >
              <p>It cuts to a fight before it starts, takes short looks at the hunters in a clutch and tells the buy story in freeze time. Every shot shows its reasons. Take the camera back with one click; the emergency stop works from anywhere in Windows.</p>
              <CheckList items={["Off, Observer, Observer & Cinematics and Full Action Observer", "Cinematic team, plant and defuse shots, smooth with HLAE", "Nade cameras on the top plan"]} />
            </Spotlight>
            <Spotlight
              id="home-replays"
              eyebrow="Replays"
              title="Every kill filmed, the best ones on air"
              reverse
              shot={<Screenshot name="console-auto-replays" alt="Automatic replays: play replays by themselves, start early when the round is decided, the best 4 clips per break, fades, and the replay PC's NDI feed." caption="Automatic replays. Real screenshot." />}
            >
              <p>A replay PC watches a few seconds behind and films each kill. Between rounds the best clips play back to back, slowed at the kill, and they can start early once the round is decided.</p>
              <CheckList items={["Slow motion at the kill, on by default", "Highlights on air and a highlight reel in one click", <>Multi-angle replays <span className="badge">Experimental</span></>]} />
            </Spotlight>
            <Spotlight
              id="home-huds"
              eyebrow="HUD Library"
              title="Four HUDs ready, or bring your own"
              shot={<Screenshot name="console-hud-library" alt="The HUD Library with Lineup, MatchFrame Broadcast, Stage and Vector HUDs, each ready to launch over the game or add to OBS." caption="The HUD Library. Real screenshot." />}
            >
              <p>Stage, Vector, Lineup and the MatchFrame Broadcast HUD, as OBS browser sources or a transparent window over CS2. Import hud.json HUDs, add your pictures, a trophy and an icon pack.</p>
              <p>
                <Link to="/features/huds" className="link-arrow">
                  All about the HUDs <Icon name="arrow" size={18} />
                </Link>
              </p>
            </Spotlight>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="setups-title">
        <div className="wrap">
          <SectionHead id="setups-title" eyebrow="How it works" title="One PC, two PCs or a whole crew" lead="Start on one computer and grow into a production network without changing tools." center />
          <ul className="tile-grid">
            {SETUPS.map((s) => (
              <li key={s.title} className="tile">
                <span className="feature-icon">
                  <Icon name={s.icon} />
                </span>
                <h3 className="feature-title">{s.title}</h3>
                <p>{s.text}</p>
                <Link to={s.to} className="link-arrow">
                  How to set it up <span className="visually-hidden">({s.title})</span>
                  <Icon name="arrow" size={18} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <PlanTeaser />

      <section className="section section-alt" aria-labelledby="faq-title">
        <div className="wrap faq-teaser">
          <div>
            <SectionHead id="faq-title" eyebrow="FAQ" title="Questions, answered" lead="The short version of what people ask before they start." />
            <p>
              <Link to="/faq" className="link-arrow">
                All frequently asked questions <Icon name="arrow" size={18} />
              </Link>
            </p>
          </div>
          <FaqList items={HOME_FAQ} />
        </div>
      </section>

      <CtaBand title="Ready for your next broadcast?" text="Download the program and rehearse with the built-in simulation before you go live. The Free plan includes every HUD and a few auto-director hours.">
        <DownloadButton />
        <Link to="/pricing" className="btn btn-on-dark btn-lg">
          See plans
        </Link>
      </CtaBand>
    </>
  );
}
