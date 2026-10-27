import { Children, isValidElement } from "react";
import type { ReactNode } from "react";
import { Link } from "../router.tsx";

export type FaqCategory = "general" | "program" | "director" | "huds" | "account" | "billing" | "privacy" | "troubleshooting";

export interface FaqItem {
  id: string;
  category: FaqCategory;
  q: string;
  a: ReactNode;
}

export const FAQ_CATEGORIES: { id: FaqCategory; title: string }[] = [
  { id: "general", title: "General" },
  { id: "program", title: "Program and installation" },
  { id: "director", title: "Auto director and hours" },
  { id: "huds", title: "HUDs and OBS" },
  { id: "account", title: "Accounts and teams" },
  { id: "billing", title: "Billing and subscriptions" },
  { id: "privacy", title: "Privacy and security" },
  { id: "troubleshooting", title: "Troubleshooting" },
];

export const FAQ: FaqItem[] = [
  // ------------------------------------------------------------------ general
  {
    id: "what-is-matchframe",
    category: "general",
    q: "What is Matchframe?",
    a: (
      <p>
        Matchframe is a Windows program for producing Counter-Strike 2 broadcasts. It runs the HUDs you add to OBS, an automatic director that can drive the observer camera, OBS and replay control, and the administration of matches, vetoes and sponsors. This website manages the account behind it: plans, auto-director hours, invoices, your team and linked computers.
      </p>
    ),
  },
  {
    id: "early-access",
    category: "general",
    q: "Is Matchframe ready for my live broadcast?",
    a: (
      <>
        <p>
          Matchframe is in early access. The program is built and tested with synthetic game data, a labelled simulation, real OBS and real CS2 demos, and the Windows installer is smoke-tested. Real CS2 telemetry ingest and real observer camera control haven't yet been verified on a real CS2 client.
        </p>
        <p>Run the in-program setup checklist and a rehearsal before going live: automatic camera control stays blocked until its tests pass on your setup.</p>
      </>
    ),
  },
  {
    id: "website-vs-program",
    category: "general",
    q: "Can I control my broadcast from this website?",
    a: <p>No. Everything that touches your broadcast runs in the program on your production computer, so a website outage can never take you off air. The website only handles accounts, payments, hours and downloads.</p>,
  },
  {
    id: "need-account",
    category: "general",
    q: "Do I need an account or an internet connection to use the program?",
    a: (
      <p>
        You need a free account: the program opens with a sign-in screen, and you sign in with the same email and password as this website. After that it works offline for up to seven days after each check, so a LAN without internet is fine. The Free plan covers HUDs, manual and advisory direction, replays, match administration and the simulation; automatic direction on live matches uses auto-director hours. See <Link to="/how-it-works#offline">what works offline</Link>.
      </p>
    ),
  },
  {
    id: "games",
    category: "general",
    q: "Which games are supported?",
    a: <p>Counter-Strike 2, through its Game State Integration feed and an observer or spectator client. Other games aren't supported.</p>,
  },
  {
    id: "valve",
    category: "general",
    q: "Is Matchframe affiliated with Valve?",
    a: <p>No. Counter-Strike 2 is a trademark of Valve Corporation. Matchframe is an independent product and isn't affiliated with or endorsed by Valve.</p>,
  },

  // ------------------------------------------------------------------ program
  {
    id: "requirements",
    category: "program",
    q: "What do I need to run the program?",
    a: (
      <p>
        A 64-bit Windows 10 or 11 computer, OBS Studio 30 or later (its built-in WebSocket server is used) and a Counter-Strike 2 observer or spectator client. See the full <Link to="/requirements">system requirements</Link>.
      </p>
    ),
  },
  {
    id: "smartscreen",
    category: "program",
    q: "Why does Windows show a SmartScreen warning?",
    a: (
      <p>
        The installer isn't code-signed yet, so Windows SmartScreen shows "Windows protected your PC". Check the SHA-256 checksum shown next to the download first, then choose <strong>More info → Run anyway</strong>. See <Link to="/help/installing-the-program">downloading and installing the program</Link>.
      </p>
    ),
  },
  {
    id: "checksum",
    category: "program",
    q: "How do I check that the installer is genuine?",
    a: (
      <p>
        The download page shows the installer's SHA-256 checksum. In PowerShell run <code>Get-FileHash .\MatchframeEsports-Setup-&lt;version&gt;.exe -Algorithm SHA256</code> and compare the result with the value on the page. They must match exactly.
      </p>
    ),
  },
  {
    id: "where-download",
    category: "program",
    q: "Where do I download the program?",
    a: (
      <p>
        Sign in and open <Link to="/download">Download the program</Link>, also linked from your dashboard and account page. The download is free; an account keeps the installer and your plan in one place.
      </p>
    ),
  },
  {
    id: "several-computers",
    category: "program",
    q: "Can we use more than one computer?",
    a: (
      <p>
        Yes. Extra operator positions connect to your production computer over the local network with role tokens issued in the program. Each computer that runs automatic direction is linked to your organisation, up to your plan's computer limit. See <Link to="/features/multi-pc">multi-PC operation</Link>.
      </p>
    ),
  },
  {
    id: "simulation",
    category: "program",
    q: "Can we rehearse without a live match?",
    a: <p>Yes. The built-in simulation plays a synthetic match so you can practise with HUDs, replays and the director. Simulated data is labelled SIMULATION everywhere and never uses hours.</p>,
  },

  // ------------------------------------------------------------------ director
  {
    id: "what-is-an-hour",
    category: "director",
    q: "What counts as an auto-director hour?",
    a: (
      <p>
        Only time in which the auto director actually controls the camera on a live match: automation armed, the director in automatic or assisted mode, a real observer client connected and live telemetry arriving. The program measures it per second and uploads it to your organisation, where you can see it on the Usage page. Manual and advisory direction, simulations and demo playback don't count, and a computer that is asleep is never billed.
      </p>
    ),
  },
  {
    id: "limit",
    category: "director",
    q: "What happens when we run out of hours?",
    a: <p>Automation that's already running is never cut off in the middle of a map: it finishes the map and then hands the camera back to your operator. After that, automatic direction can't be re-armed until hours are added or the next period starts. Everything else in the program keeps working.</p>,
  },
  {
    id: "replace-observer",
    category: "director",
    q: "Does the auto director replace a human observer?",
    a: <p>It's designed to work with one. The director explains every shot it picks, the operator can take the camera back at any moment (manual takeover sticks until automation is resumed), and an emergency stop is always one key away. It also starts disarmed every time the program starts.</p>,
  },
  {
    id: "modes",
    category: "director",
    q: "What's the difference between advisory, assisted and automatic?",
    a: <p>Advisory only recommends shots and never moves the camera. Assisted lets the director make player cuts. Automatic also allows cinematic shots from validated static cameras. Assisted and automatic use auto-director hours on live matches.</p>,
  },
  {
    id: "emergency-stop",
    category: "director",
    q: "How do I stop automation immediately?",
    a: (
      <p>
        Press <kbd>F8</kbd> or <kbd>Pause</kbd> in the program, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F12</kbd> anywhere in Windows, use the Stop automation button, or choose Automation → Emergency stop. Emergency stop cancels pending commands and blocks automation until you clear it.
      </p>
    ),
  },
  {
    id: "camera-tests",
    category: "director",
    q: "Why won't the director move the camera yet?",
    a: (
      <p>
        Automatic camera control stays blocked until the in-program setup tests pass on your observer client: the player-selection test for player cuts, and the static camera test plus operator-validated cameras for cinematic shots. Until then the director works in advisory mode. See <Link to="/features/cameras">observer camera control</Link>.
      </p>
    ),
  },
  {
    id: "ai",
    category: "director",
    q: "Does the director use AI?",
    a: <p>Live decisions come from a rule-based director with explainable scoring; no language model is involved in the cut loop. Models trained from demos only run in shadow mode for comparison and never move the camera.</p>,
  },

  // ------------------------------------------------------------------ huds
  {
    id: "own-hud",
    category: "huds",
    q: "Can I use my own HUD design?",
    a: <p>Yes. The program ships with Classic, Minimal and Arena presets and their variants (pre-match, veto, live, post-map, standings and bracket), and you can import your own HUD package. Every output has a draft and a published revision, so changes only go on air when you publish them.</p>,
  },
  {
    id: "add-to-obs",
    category: "huds",
    q: "How do I add a HUD to OBS?",
    a: <p>In HUDs &amp; Composer, publish an output and copy its URL. In OBS, add a Browser Source with that URL at 1920×1080. The program can also create the source for you once OBS is connected.</p>,
  },
  {
    id: "obs-version",
    category: "huds",
    q: "Which OBS version do I need?",
    a: <p>OBS Studio 30 or later. Its built-in WebSocket server (obs-websocket 5) is used for scenes, sources, audio and replays. HUDs work in any OBS version with browser sources.</p>,
  },
  {
    id: "replays",
    category: "huds",
    q: "How do replays work?",
    a: (
      <p>
        Enable the replay buffer in OBS. In the program you bookmark moments, approve them in a queue and play them out through a media source, then return live. See <Link to="/features/obs-replays">OBS control and replays</Link>.
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
    id: "invite",
    category: "account",
    q: "How do I add someone to my team?",
    a: <p>Owners and admins invite people from the Team page with an email address and a role. The invitation link expires after 7 days, and pending invitations count towards the plan's member limit.</p>,
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

  // ------------------------------------------------------------------ billing
  {
    id: "overage",
    category: "billing",
    q: "Are there overage charges?",
    a: <p>No. Hours are never sold after the fact, so there are no surprise bills. You decide when to add hours, by buying an hour pack or moving to a larger plan.</p>,
  },
  {
    id: "packs",
    category: "billing",
    q: "How do hour packs work?",
    a: <p>Hour packs add auto-director hours on any plan, including Free. They're valid for 365 days from purchase and are used after your plan's included hours, earliest expiry first.</p>,
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
    a: <p>Owners and billing members can change or cancel the subscription at any time in the customer portal (Billing &amp; Subscription → Manage subscription). A cancelled plan stays active until the end of the period you've paid for, then the organisation moves to the Free plan.</p>,
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
        Subscriptions can be cancelled at any time and aren't renewed after that, but periods already started aren't usually refunded. Unused hour packs can be refunded within 14 days. See the <Link to="/legal/refunds">refund and cancellation policy</Link>.
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
  {
    id: "sessions",
    category: "privacy",
    q: "How do I see where my account is signed in?",
    a: (
      <p>
        Your account page lists every signed-in browser with its device, IP address and last activity. End any of them, or sign out all other sessions. See <Link to="/help/sessions-and-your-data">active sessions</Link>.
      </p>
    ),
  },

  // ------------------------------------------------------------------ troubleshooting
  {
    id: "no-gsi",
    category: "troubleshooting",
    q: "The program shows no game data from CS2.",
    a: <p>Re-run Detect CS2 and Write the GSI config in the setup checklist, then restart CS2 completely. Make sure the client is spectating or observing a match and that nothing else uses port 37210. With two computers, the config must point at the production computer's address and the port must be allowed through its firewall.</p>,
  },
  {
    id: "obs-connect",
    category: "troubleshooting",
    q: "The program can't connect to OBS.",
    a: <p>In OBS open Tools → WebSocket Server Settings, enable the server and note the port and password. Enter the same values in Devices &amp; Integrations. OBS 30 or later is needed for the built-in WebSocket server.</p>,
  },
  {
    id: "hud-blank",
    category: "troubleshooting",
    q: "My HUD browser source is blank in OBS.",
    a: <p>Check that the output is published (not only drafted) and that you copied the full URL including its token. Set the source to 1920×1080. A delayed output stays empty until its delay buffer has filled.</p>,
  },
  {
    id: "cant-arm",
    category: "troubleshooting",
    q: "Automation won't arm.",
    a: (
      <p>
        The program says why. Common reasons: the program was signed out on the website, the organisation has no hours left, the plan doesn't include automatic direction, the player-selection test hasn't passed for this game build, or the data is simulated. Check Account &amp; Hours in the program and your <Link to="/dashboard">dashboard</Link>.
      </p>
    ),
  },
  {
    id: "sign-in-program",
    category: "troubleshooting",
    q: "I can't sign in to the program.",
    a: (
      <p>
        Use the same email and password as this website, and confirm your email address first (the program can't sign in before that). If you belong to several organisations, the program asks which one the computer is for. "This plan allows 1 signed-in computer" means the organisation has no free computer slot: sign out an old computer on the Computers page or move to a larger plan. Forgot your password? <Link to="/forgot-password">Reset it here</Link>, then sign in again.
      </p>
    ),
  },
  {
    id: "signed-out",
    category: "troubleshooting",
    q: "Why was the program signed out?",
    a: <p>A computer is signed out when the account's password is changed or reset, the account is disabled, its person leaves the organisation, or the computer is unlinked on the Computers page. A program that is already open keeps running and shows a notice; it asks you to sign in the next time it opens.</p>,
  },
  {
    id: "link-code",
    category: "troubleshooting",
    q: "My sign-in code doesn't work.",
    a: <p>Codes (the "sign in with a code" option) expire after 10 minutes and work once. Get a new code in the program. If the organisation has no free computer slot, sign out an old computer or move to a larger plan.</p>,
  },
  {
    id: "no-email",
    category: "troubleshooting",
    q: "I didn't receive the verification or reset email.",
    a: (
      <p>
        Check your spam folder and the spelling of your address, then send a new link. Verification links expire after 48 hours and reset links after 60 minutes. Still nothing? <Link to="/contact?topic=support">Contact support</Link>.
      </p>
    ),
  },
  {
    id: "disabled",
    category: "troubleshooting",
    q: "Sign-in says my account has been disabled.",
    a: (
      <p>
        Our team can disable an account, for example after a security concern or a breach of the acceptable use policy. <Link to="/contact?topic=support">Contact support</Link> from the account's email address and we'll explain what happened.
      </p>
    ),
  },
];

export const faqById = (id: string): FaqItem | undefined => FAQ.find((f) => f.id === id);

/** Plain text of a JSX answer, for searching. */
export function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join(" ");
  if (isValidElement<{ children?: ReactNode }>(node)) return Children.toArray(node.props.children).map(nodeText).join(" ");
  return "";
}

/** Questions whose text or answer contains every word of the query (case-insensitive). */
export function filterFaq(items: FaqItem[], query: string): FaqItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  return items.filter((f) => {
    const hay = `${f.q} ${nodeText(f.a)}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Accordion list of questions (native <details>, keyboard and screen-reader friendly). */
export function FaqList({ items, open }: { items: FaqItem[]; open?: boolean }) {
  return (
    <div className="faq-list">
      {items.map((f) => (
        <details key={f.id} className="faq-item" id={`faq-${f.id}`} open={open || undefined}>
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
