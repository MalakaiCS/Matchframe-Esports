import { LogoMark } from "../components/Logo.tsx";
import { useTitle } from "../lib/hooks.ts";
import { Link } from "../router.tsx";
import { useSession } from "../state/session.tsx";

/** Minimal home: what this website is for, sign in / create account, pricing. */
export function Landing() {
  useTitle("");
  const { me } = useSession();
  return (
    <section className="home">
      <div className="wrap home-inner">
        <LogoMark size={52} />
        <h1 tabIndex={-1} data-page-heading>
          Your Matchframe account
        </h1>
        <p className="lead">Manage your Matchframe subscription, auto-director hours, team and computers. The Matchframe program for Windows runs HUDs, the auto director and cameras.</p>
        <div className="home-cta">
          {me ? (
            <Link to="/dashboard" className="btn btn-primary btn-lg">
              Open your dashboard
            </Link>
          ) : (
            <>
              <Link to="/signup" className="btn btn-primary btn-lg">
                Create account
              </Link>
              <Link to="/login" className="btn btn-secondary btn-lg">
                Sign in
              </Link>
            </>
          )}
        </div>
        <p className="home-pricing">
          <Link to="/pricing">See plans and pricing</Link>
        </p>
      </div>
    </section>
  );
}
