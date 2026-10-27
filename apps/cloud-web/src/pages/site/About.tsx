import { CtaBand, FeatureGrid, PageHero, SectionHead } from "../../components/marketing.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { useSite } from "../../state/site.ts";

export function About() {
  useTitle("About", "About Matchframe: who builds it, what we believe about live production, and how to reach us.");
  const { site } = useSite();
  return (
    <>
      <PageHero eyebrow="About" title="Production tools that respect the people running the show" lead="Matchframe is built for tournament organisers, leagues and production crews who want broadcast-quality Counter-Strike 2 coverage without stitching together a dozen tools." />

      <section className="section" aria-labelledby="story-title">
        <div className="wrap two-col-lg">
          <div>
            <SectionHead id="story-title" eyebrow="What we build" title="Two products, one job" />
          </div>
          <div className="prose prose-lead">
            <p>
              <strong>The Matchframe program</strong> is a Windows application that runs on the production computer. It takes the game's live data, drives the HUDs in OBS, directs the observer camera when you let it, plays replays and keeps the running order, vetoes and sponsor slots in one place.
            </p>
            <p>
              <strong>This website</strong> handles everything around it: accounts, teams, linked computers, plans, auto-director hours and invoices. It deliberately contains no broadcast controls, so nothing that happens here can take your show off air.
            </p>
          </div>
        </div>
      </section>

      <section className="section section-alt" aria-labelledby="values-title">
        <div className="wrap">
          <SectionHead id="values-title" eyebrow="What we believe" title="Our principles" center />
          <FeatureGrid
            columns={2}
            items={[
              { icon: "stop", title: "The operator is in charge", text: "Automation starts disarmed, manual takeover sticks, and an emergency stop is always one key away. The director explains itself and never fights the operator." },
              { icon: "check", title: "Honest about evidence", text: "Simulated data is labelled everywhere. Predictions are never shown as facts, and camera control is only used once it has been tested on your setup." },
              { icon: "offline", title: "Offline-first", text: "Your broadcast doesn't depend on our servers. Only automatic direction on live matches needs an account, and even that keeps working offline for days." },
              { icon: "lock", title: "Private by default", text: "Telemetry, graphics and recordings stay on your computers. We keep only what accounts and billing need, and we don't use tracking cookies." },
            ]}
          />
        </div>
      </section>

      {site && (
        <section className="section" aria-labelledby="company-title">
          <div className="wrap two-col-lg">
            <SectionHead id="company-title" eyebrow="Company" title="Who we are" />
            <dl className="spec-list">
              <div>
                <dt>Company</dt>
                <dd>{site.companyName}</dd>
              </div>
              {site.address && (
                <div>
                  <dt>Address</dt>
                  <dd className="pre-line">{site.address}</dd>
                </div>
              )}
              {site.supportEmail && (
                <div>
                  <dt>Email</dt>
                  <dd>
                    <a href={`mailto:${site.supportEmail}`}>{site.supportEmail}</a>
                  </dd>
                </div>
              )}
              <div>
                <dt>Contact</dt>
                <dd>
                  <Link to="/contact">Contact form</Link>
                </dd>
              </div>
            </dl>
          </div>
        </section>
      )}

      <CtaBand title="Let's talk about your next event" text="Planning a season, a LAN final or a league with several broadcasts? We're happy to help you size the right plan.">
        <Link to="/contact?topic=sales" className="btn btn-primary btn-lg">
          Contact us
        </Link>
        <Link to="/features" className="btn btn-on-dark btn-lg">
          Explore the program
        </Link>
      </CtaBand>
    </>
  );
}
