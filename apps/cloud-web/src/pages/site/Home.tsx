import { api } from "../../api/index.ts";
import { Icon } from "../../components/icons.tsx";
import { CheckList, CtaBand, FeatureGrid, Screenshot, SectionHead, Spotlight, Steps } from "../../components/marketing.tsx";
import { PlanCard } from "../../components/PlanCard.tsx";
import { FaqList, faqById } from "../../content/faq.tsx";
import type { FaqItem } from "../../content/faq.tsx";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { useSession } from "../../state/session.tsx";

const HOME_FAQ = ["need-account", "what-is-an-hour", "limit", "replace-observer"].map(faqById).filter((f): f is FaqItem => !!f);

function PlanTeaser() {
  const plans = useResource("plans", api.plans);
  const list = plans.data?.plans ?? [];
  return (
    <section className="section" aria-labelledby="plans-title">
      <div className="wrap">
        <SectionHead id="plans-title" eyebrow="Pricing" title="Start free. Pay for automation when you need it." lead="Every plan includes the full program. Plans differ in auto-director hours, linked computers and team size. No overage charges, ever." center />
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

export function Home() {
  useTitle("", "Matchframe is the Windows program for Counter-Strike 2 broadcasts: HUDs for OBS, the Observer auto director with manual takeover, observer camera control, replays and match administration.");
  const { me } = useSession();
  return (
    <>
      <section className="hero">
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <p className="hero-eyebrow">
              <span className="tally-dot" aria-hidden="true" /> Early access · Broadcast production for Counter-Strike 2
            </p>
            <h1 tabIndex={-1} data-page-heading>
              Run your whole CS2 broadcast from one Windows program
            </h1>
            <p className="hero-lead">HUDs for OBS, the Observer auto director designed to drive the observer camera, replays and match administration, together on your production PC. You stay in control of every shot.</p>
            <div className="hero-cta">
              {me ? (
                <Link to="/dashboard" className="btn btn-primary btn-lg">
                  Open your dashboard
                </Link>
              ) : (
                <Link to="/signup" className="btn btn-primary btn-lg">
                  Create account
                </Link>
              )}
              <Link to="/features" className="btn btn-on-dark btn-lg">
                Explore the program
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
                <Icon name="offline" size={16} /> Works offline
              </li>
            </ul>
          </div>
          <div className="hero-media">
            <Screenshot name="live-control" eager alt="The Live Control screen of the Matchframe program: player cards for both teams, the director's recommended shot with its reasons, and operator actions including Stop automation." caption="Live Control in the Matchframe program. Real screenshot; the match data is simulated." />
          </div>
        </div>
      </section>

      <section className="strip" aria-label="Highlights">
        <div className="wrap strip-grid">
          <p>
            <strong>Manual takeover</strong> at any moment
          </p>
          <p>
            <strong>Emergency stop</strong> from anywhere in Windows
          </p>
          <p>
            <strong>Multi-PC</strong> operator positions
          </p>
          <p>
            <strong>Offline-first</strong>: only live automation uses hours
          </p>
        </div>
      </section>

      <section className="section" aria-labelledby="how-title">
        <div className="wrap">
          <SectionHead id="how-title" eyebrow="How it works" title="On air in three steps" lead="The program does the broadcast work. This website keeps the account, plan and hours behind it." center />
          <Steps
            items={[
              { icon: "download", title: "Download the program", text: <p>Create a free account, download the Windows installer and check its SHA-256 checksum. The in-program setup checklist walks you through CS2, OBS and your first HUD.</p> },
              { icon: "link", title: "Sign in to the program", text: <p>Start the program and sign in with the same email and password as this website. It uses your organisation's plan and hours, and works offline for up to seven days after each check.</p> },
              { icon: "card", title: "Choose a plan or buy hours", text: <p>Start on the Free plan. Move to a larger plan for more auto-director hours, computers and team members, or top up with hour packs.</p> },
            ]}
          />
          <p className="center-text section-foot">
            <Link to="/how-it-works" className="link-arrow">
              Read the full getting-started guide <Icon name="arrow" size={18} />
            </Link>
          </p>
        </div>
      </section>

      <section className="section section-alt" aria-labelledby="features-title">
        <div className="wrap">
          <SectionHead id="features-title" eyebrow="The program" title="Everything the production desk needs" lead="Built for tournament crews who want broadcast-quality coverage without a room full of tools." center />
          <div className="spotlights">
            <Spotlight
              id="home-huds"
              eyebrow="HUDs for OBS"
              title="Broadcast graphics as browser sources"
              shot={<Screenshot name="hud-broadcast" alt="A Matchframe HUD over the game view: scoreboard with team names and round timer, player cards on both sides, the observed player's panel and a minimap." caption="Built-in HUD, Classic preset. Simulated match data." />}
            >
              <p>Add one URL per output to OBS. Presets and variants cover pre-match, veto, live, post-map, standings and brackets, or import your own HUD package.</p>
              <CheckList items={["Draft and publish revisions; roll back instantly", "Per-output access tokens and broadcast delay", "Cues and annotations go on air immediately"]} />
            </Spotlight>
            <Spotlight
              id="home-director"
              eyebrow="Observer (auto director)"
              title="An automatic observer you stay in charge of"
              reverse
              shot={<Screenshot name="live-control" alt="The director panel in Live Control showing the recommended shot, the reasons for it and the best alternative candidates." caption="The Observer explains each shot it picks. Simulated match data." />}
            >
              <p>The Observer is designed to anticipate fights and utility, switch POVs, add cinematic shots and show you why. On the top plan, nade cameras catch the utility as it lands. Take the camera back with one click; emergency stop works from anywhere in Windows.</p>
              <CheckList items={["Off, Observer, Observer & Cinematics and Full Action Observer", "Starts disarmed every time", "Never cut off mid-map when hours run out"]} />
            </Spotlight>
            <Spotlight
              id="home-admin"
              eyebrow="Match administration"
              title="Matches, vetoes and sponsors in one place"
              shot={<Screenshot name="matches-veto" alt="The Matches & Veto screen: a veto board with bans, picks and side choices, the result and a history of decisions." caption="Veto board with captain links. Simulated teams." />}
            >
              <p>Run events, teams and series, let captains veto from their own link, and schedule sponsor slots with delivery acknowledgements.</p>
            </Spotlight>
          </div>
          <FeatureGrid
            columns={3}
            items={[
              { icon: "camera", title: "Observer camera control", text: "Player cuts, validated cinematic cameras and nade cameras through one control channel, gated by setup tests on your client." },
              { icon: "replay", title: "Replays and OBS", text: "Bookmark moments, approve them in a queue and play them out through OBS, then return live." },
              { icon: "network", title: "Multi-PC positions", text: "Extra operators connect to the production computer with role-scoped tokens." },
              { icon: "grenade", title: "Grenade tracking", text: "All six grenade types from both teams, with predictions kept apart from confirmed events." },
              { icon: "stop", title: "Safety built in", text: "Single writer for the camera, sticky manual takeover and a global emergency stop." },
              { icon: "model", title: "Demo-trained models", text: "Train models from CS2 demos and evaluate them in shadow mode, away from the live camera." },
            ]}
          />
          <p className="center-text section-foot">
            <Link to="/features" className="link-arrow">
              See everything the program does <Icon name="arrow" size={18} />
            </Link>
          </p>
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

      <CtaBand title="Ready for your next broadcast?" text="Create a free account, download the program and rehearse with the built-in simulation before you go live.">
        {me ? (
          <Link to="/download" className="btn btn-primary btn-lg">
            Download the program
          </Link>
        ) : (
          <Link to="/signup" className="btn btn-primary btn-lg">
            Create your free account
          </Link>
        )}
        <Link to="/contact?topic=sales" className="btn btn-on-dark btn-lg">
          Talk to us
        </Link>
      </CtaBand>
    </>
  );
}
