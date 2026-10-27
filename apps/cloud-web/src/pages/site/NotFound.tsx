import { LogoMark } from "../../components/Logo.tsx";
import { Icon } from "../../components/icons.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { useSession } from "../../state/session.tsx";

export function NotFound() {
  useTitle("Page not found", "This page doesn't exist on the Matchframe website.");
  const { me } = useSession();
  return (
    <section className="wrap section not-found">
      <div className="not-found-mark" aria-hidden="true">
        <LogoMark size={64} />
        <span className="not-found-code">404</span>
      </div>
      <h1 tabIndex={-1} data-page-heading>
        Page not found
      </h1>
      <p className="lead-text">That address doesn't match any page on this site. It may have moved, or the link may be mistyped.</p>
      <div className="button-row center-row">
        <Link to="/" className="btn btn-primary">
          Go to the home page
        </Link>
        {me ? (
          <Link to="/dashboard" className="btn btn-secondary">
            Open your dashboard
          </Link>
        ) : (
          <Link to="/help" className="btn btn-secondary">
            Visit the help centre
          </Link>
        )}
      </div>
      <ul className="not-found-links">
        <li>
          <Link to="/features">
            <Icon name="hud" size={18} /> Product
          </Link>
        </li>
        <li>
          <Link to="/pricing">
            <Icon name="card" size={18} /> Pricing
          </Link>
        </li>
        <li>
          <Link to="/faq">
            <Icon name="book" size={18} /> FAQ
          </Link>
        </li>
        <li>
          <Link to="/contact">
            <Icon name="mail" size={18} /> Contact
          </Link>
        </li>
      </ul>
    </section>
  );
}
