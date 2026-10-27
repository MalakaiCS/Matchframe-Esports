import type { ReactNode } from "react";
import { Link } from "../router.tsx";

export type FaqCategory = "product" | "billing" | "account" | "program" | "privacy";

export interface FaqItem {
  id: string;
  category: FaqCategory;
  q: string;
  a: ReactNode;
}

export const FAQ_CATEGORIES: { id: FaqCategory; title: string }[] = [
  { id: "product", title: "The product" },
  { id: "billing", title: "Plans, hours and billing" },
  { id: "account", title: "Accounts and teams" },
  { id: "program", title: "Installing and running the program" },
  { id: "privacy", title: "Privacy and security" },
];

export const FAQ: FaqItem[] = [
  // ------------------------------------------------------------------ product
  {
    id: "what-is-matchframe",
    category: "product",
    q: "What is Matchframe?",
    a: (
      <p>
        Matchframe is a Windows program for producing Counter-Strike 2 broadcasts. It runs the HUDs you add to OBS, an automatic director that can drive the observer camera, OBS and replay control, and the administration of matches, vetoes and sponsors. This website is where you manage the account behind it: plans, auto-director hours, invoices, your team and linked computers.
      </p>
    ),
  },
  {
    id: "website-vs-program",
    category: "product",
    q: "Can I control my broadcast from this website?",
    a: (
      <p>
        No. Everything that touches your broadcast runs in the program on your production computer, so a website outage can never take you off air. The website only handles accounts, payments, hours and downloads.
      </p>
    ),
  },
  {
    id: "need-account",
    category: "product",
    q: "Do I need an account or an internet connection to use the program?",
    a: (
      <p>
        Not for most of it. HUDs, manual and advisory direction, replays, match administration and the built-in simulation work offline without an account. Only automatic direction on live matches needs a linked computer with auto-director hours left. A licence that has been fetched keeps working offline for up to seven days.
      </p>
    ),
  },
  {
    id: "replace-observer",
    category: "product",
    q: "Does the auto director replace a human observer?",
    a: (
      <p>
        It's designed to work with one. The director explains every shot it picks, the operator can take the camera back at any moment (manual takeover sticks until automation is resumed), and an emergency stop is always one key away. It also starts disarmed every time the program starts.
      </p>
    ),
  },
  {
    id: "games",
    category: "product",
    q: "Which games are supported?",
    a: <p>Counter-Strike 2, through its Game State Integration feed and an observer or spectator client. Other games aren't supported.</p>,
  },
  {
    id: "own-hud",
    category: "product",
    q: "Can I use my own HUD design?",
    a: (
      <p>
        Yes. The program ships with built-in presets and variants (pre-match, veto, live, post-map, standings and bracket), and you can import your own HUD package. Every output has a draft and a published revision, so changes only go on air when you publish them.
      </p>
    ),
  },

  // ------------------------------------------------------------------ billing
  {
    id: "what-is-an-hour",
    category: "billing",
    q: "What counts as an auto-director hour?",
    a: (
      <p>
        Only time in which the auto director actually controls the camera on a live match: automation armed, the director in automatic or assisted mode, a real observer client connected and live telemetry arriving. The program measures it per second and uploads it to your organisation, where you can see it on the Usage page. Manual and advisory direction, simulations and demo playback don't count, and a computer that is asleep is never billed.
      </p>
    ),
  },
  {
    id: "limit",
    category: "billing",
    q: "What happens when we run out of hours?",
    a: (
      <p>
        Automation that is already running is never cut off in the middle of a map: it finishes the map and then hands the camera back to your operator. After that, automatic direction can't be re-armed until hours are added or the next period starts. Everything else in the program keeps working.
      </p>
    ),
  },
  {
    id: "overage",
    category: "billing",
    q: "Are there overage charges?",
    a: <p>No. Hours are never sold after the fact, so there are no surprise bills. You decide when to add hours, by buying an hour pack or moving to a larger plan.</p>,
  },
  {
    id: "packs",
    category: "billing",
    q: "How long do hour packs last?",
    a: (
      <p>
        Hour packs are valid for 365 days from purchase. They're used after your plan's included hours, earliest expiry first, and you can buy them on any plan, including Free.
      </p>
    ),
  },
  {
    id: "reset",
    category: "billing",
    q: "When do included hours reset?",
    a: <p>At the start of each billing period on a paid plan, and each calendar month on the Free plan. Included hours don't roll over.</p>,
  },
  {
    id: "cancel",
    category: "billing",
    q: "How do I cancel or change my plan?",
    a: (
      <p>
        Owners and billing members can change or cancel the subscription at any time in the customer portal (Billing &amp; Subscription → Manage subscription). A cancelled plan stays active until the end of the period you've paid for, then the organisation moves to the Free plan.
      </p>
    ),
  },
  {
    id: "payments",
    category: "billing",
    q: "How are payments handled?",
    a: (
      <p>
        Payments are processed by Stripe. Card details are entered on Stripe's pages and never reach our servers. Invoices and receipts are available in the customer portal; see <Link to="/help/invoices-and-billing-portal">invoices and the billing portal</Link>.
      </p>
    ),
  },
  {
    id: "refunds",
    category: "billing",
    q: "Can I get a refund?",
    a: (
      <p>
        Subscriptions can be cancelled at any time and aren't renewed after that, but periods already started aren't usually refunded. See the <Link to="/legal/refunds">refund and cancellation policy</Link> for the details and exceptions.
      </p>
    ),
  },

  // ------------------------------------------------------------------ account
  {
    id: "roles",
    category: "account",
    q: "What can each team role do?",
    a: (
      <p>
        Owners can do everything. Admins manage members, computers and the organisation name. Billing members handle the plan, payments and invoices. Members link computers and see usage. See <Link to="/help/team-roles">team roles and permissions</Link>.
      </p>
    ),
  },
  {
    id: "several-orgs",
    category: "account",
    q: "Can I belong to more than one organisation?",
    a: <p>Yes. Each organisation has its own plan, hours, computers and team. Switch between them with the organisation menu in your dashboard, or create another one from your account page.</p>,
  },
  {
    id: "delete-account",
    category: "account",
    q: "How do I delete my account or get a copy of my data?",
    a: (
      <p>
        You can download a copy of your data from your account page at any time. To delete your account, <Link to="/contact?topic=support">contact support</Link>; we'll delete it together with your personal data, except records we're required to keep, such as invoices.
      </p>
    ),
  },

  // ------------------------------------------------------------------ program
  {
    id: "requirements",
    category: "program",
    q: "What do I need to run the program?",
    a: (
      <p>
        A 64-bit Windows 10 or 11 computer, OBS Studio 30 or later (its built-in WebSocket server is used) and a Counter-Strike 2 observer or spectator client. See the full <Link to="/product#requirements">system requirements</Link>.
      </p>
    ),
  },
  {
    id: "smartscreen",
    category: "program",
    q: "Why does Windows show a SmartScreen warning?",
    a: (
      <p>
        The installer isn't code-signed yet, so Windows SmartScreen asks you to confirm. Check the SHA-256 checksum shown next to the download first, then choose <strong>More info → Run anyway</strong>. See <Link to="/help/installing-the-program">downloading and installing the program</Link>.
      </p>
    ),
  },
  {
    id: "several-computers",
    category: "program",
    q: "Can we use more than one computer?",
    a: (
      <p>
        Yes. Extra operator positions connect to your production computer over the local network with role tokens issued in the program. Each computer that uses automatic direction is linked to your organisation, up to your plan's computer limit.
      </p>
    ),
  },
  {
    id: "camera-tests",
    category: "program",
    q: "Why won't the director move the camera yet?",
    a: (
      <p>
        Automatic camera control stays blocked until the in-program setup tests pass on your observer client: the player-selection test for player cuts, and the static camera test plus operator-validated cameras for cinematic shots. Until then the director works in advisory mode.
      </p>
    ),
  },

  // ------------------------------------------------------------------ privacy
  {
    id: "card-data",
    category: "privacy",
    q: "Do you store my card details?",
    a: <p>No. Stripe collects and stores payment details. We only keep a reference to your Stripe customer and the invoices it creates.</p>,
  },
  {
    id: "what-data",
    category: "privacy",
    q: "What data do you keep about my broadcasts?",
    a: (
      <p>
        Only what billing needs: the linked computer, and when and for how long the auto director ran (with the map and match label you gave it). Telemetry, HUD content and recordings stay on your computers. See the <Link to="/security">security overview</Link> and the <Link to="/legal/privacy">privacy policy</Link>.
      </p>
    ),
  },
  {
    id: "cookies",
    category: "privacy",
    q: "Why is there no cookie banner?",
    a: (
      <p>
        We only use one essential cookie that keeps you signed in. There are no analytics, advertising or tracking cookies, so there's nothing to consent to. See the <Link to="/legal/cookies">cookie policy</Link>.
      </p>
    ),
  },
];

export const faqById = (id: string): FaqItem | undefined => FAQ.find((f) => f.id === id);

/** Accordion list of questions (native <details>, keyboard and screen-reader friendly). */
export function FaqList({ items }: { items: FaqItem[] }) {
  return (
    <div className="faq-list">
      {items.map((f) => (
        <details key={f.id} className="faq-item" id={`faq-${f.id}`}>
          <summary>
            <span>{f.q}</span>
            <span className="faq-chevron" aria-hidden="true" />
          </summary>
          <div className="faq-answer">{f.a}</div>
        </details>
      ))}
    </div>
  );
}
