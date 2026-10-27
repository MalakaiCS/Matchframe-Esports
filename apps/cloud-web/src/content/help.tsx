import type { ReactNode } from "react";
import type { IconName } from "../components/icons.tsx";
import { Link } from "../router.tsx";

export type HelpCategory = "start" | "billing" | "team" | "account";

export const HELP_CATEGORIES: { id: HelpCategory; title: string; text: string; icon: IconName }[] = [
  { id: "start", title: "Getting started", text: "Create an account, install the program and link your first computer.", icon: "download" },
  { id: "billing", title: "Plans and billing", text: "Plans, auto-director hours, hour packs, invoices and the billing portal.", icon: "card" },
  { id: "team", title: "Team and computers", text: "Roles and permissions, invitations and unlinking computers.", icon: "users" },
  { id: "account", title: "Account and security", text: "Passwords, sessions and your data.", icon: "lock" },
];

export interface HelpArticle {
  slug: string;
  category: HelpCategory;
  title: string;
  summary: string;
  keywords: string;
  body: ReactNode;
}

export const HELP_ARTICLES: HelpArticle[] = [
  {
    slug: "creating-an-account",
    category: "start",
    title: "Creating an account",
    summary: "Sign up, name your organisation and find your way around the dashboard.",
    keywords: "sign up signup register new account organisation team free",
    body: (
      <>
        <p>A Matchframe account is free. It gives you an organisation, which is where your plan, auto-director hours, linked computers and team live.</p>
        <h2>Sign up</h2>
        <ol>
          <li>
            Open <Link to="/signup">Create account</Link>.
          </li>
          <li>Enter your name, your email address and a password of at least 10 characters.</li>
          <li>Enter a team or organisation name, usually your production team or league. You can rename it later from the Team page.</li>
          <li>
            Choose <strong>Create account</strong>. You're signed in straight away and we send you an email to confirm your address.
          </li>
        </ol>
        <p>
          Some actions wait until your email address is confirmed: buying a plan or hours, inviting people, linking computers and creating more organisations. See <Link to="/help/verifying-your-email">verifying your email address</Link>.
        </p>
        <h2>Your dashboard</h2>
        <p>The dashboard shows your plan, the auto-director hours left this period and your linked computers. The menu on the left leads to Usage, Billing &amp; Subscription, Team and Computers. Your account page holds your profile, email, password, sessions and the program download.</p>
        <h2>Joining an existing team instead</h2>
        <p>If someone invited you, open the link in the invitation email. You can sign in or create an account from there, using the address the invitation was sent to, and then accept it.</p>
      </>
    ),
  },
  {
    slug: "verifying-your-email",
    category: "start",
    title: "Verifying your email address",
    summary: "Confirm your address to unlock purchases, invitations and linking computers.",
    keywords: "verify verification confirm email link expired resend not received spam",
    body: (
      <>
        <p>When you sign up we email you a confirmation link. Opening it confirms that the address is yours.</p>
        <h2>Didn't get the email?</h2>
        <ul>
          <li>Check your spam or junk folder, and any filters that sort automated mail.</li>
          <li>
            Make sure the address on your <Link to="/account">account page</Link> is spelled correctly.
          </li>
          <li>
            Send a new link with <strong>Resend email</strong> in the yellow banner, or <strong>Resend verification email</strong> on your account page.
          </li>
        </ul>
        <h2>The link doesn't work</h2>
        <p>Verification links expire after 48 hours and work once. Request a new one from your account page; only the newest link is needed.</p>
        <h2>Changing your email address</h2>
        <p>On your account page, enter the new address and your password. We send a confirmation link to the new address, and your sign-in email changes only once you open it. Your old address is told about the change.</p>
      </>
    ),
  },
  {
    slug: "installing-the-program",
    category: "start",
    title: "Downloading and installing the program",
    summary: "Get the Windows installer, check its checksum and get past SmartScreen safely.",
    keywords: "download install installer exe windows smartscreen checksum sha256 sha-256 get-filehash unsigned setup",
    body: (
      <>
        <p>The Matchframe program runs on 64-bit Windows 10 and 11. Install it on each computer that should run HUDs, direction or replays.</p>
        <h2>Download</h2>
        <ol>
          <li>Sign in and open <Link to="/download">Download the program</Link> (also linked from your dashboard and account page).</li>
          <li>
            Choose <strong>Download for Windows</strong>. The file is called <code>MatchframeEsports-Setup-&lt;version&gt;.exe</code>.
          </li>
        </ol>
        <h2>Check the checksum</h2>
        <p>The download page shows the installer's SHA-256 checksum. To check the file you downloaded, open PowerShell in your Downloads folder and run:</p>
        <pre className="code-block">
          <code>Get-FileHash .\MatchframeEsports-Setup-0.1.0.exe -Algorithm SHA256</code>
        </pre>
        <p>Replace the version with the one you downloaded. The hash must match the one on the download page exactly. If it doesn't, delete the file and download it again.</p>
        <h2>Windows SmartScreen</h2>
        <p>
          The installer isn't code-signed yet, so Windows shows <em>"Windows protected your PC"</em>. After checking the checksum, choose <strong>More info</strong> and then <strong>Run anyway</strong>.
        </p>
        <h2>Install and set up</h2>
        <ol>
          <li>Run the installer and choose a folder. It installs for the current Windows user.</li>
          <li>
            Start <strong>Matchframe Esports</strong> and <Link to="/help/linking-a-computer">sign in</Link> with your Matchframe email and password.
          </li>
          <li>
            The program opens on Overview with the <strong>Setup</strong> checklist: detect CS2, write the Game State Integration config, connect OBS and add your HUD.
          </li>
        </ol>
      </>
    ),
  },
  {
    slug: "linking-a-computer",
    category: "start",
    title: "Signing in to the program",
    summary: "Sign in to the program with your Matchframe email and password; it then uses your organisation's plan and hours.",
    keywords: "sign in login password program computer link device code approve organisation slot limit account & hours offline signed out",
    body: (
      <>
        <p>The program opens with a sign-in screen. Signing in connects that computer to your organisation's plan and auto-director hours. It's the same account as this website.</p>
        <h2>Sign in</h2>
        <ol>
          <li>Start the program. Enter the email and password you use on this website and select <strong>Sign in</strong>.</li>
          <li>If you belong to more than one organisation, choose which one this computer is for.</li>
          <li>The program opens. <strong>Account &amp; Hours</strong> shows who it is signed in as, the plan and the hours left.</li>
        </ol>
        <p>Your password is sent to Matchframe once and never stored on the computer. Confirm your email address before signing in.</p>
        <h2>Sign in with a code instead</h2>
        <p>
          On the sign-in screen choose <strong>Sign in with a code from the website</strong>. The program shows a code like <code>BCDF-GHJK</code>. Open the <Link to="/link">link page</Link> on this website, check the code and the computer's name, choose the organisation and select <strong>Approve and link</strong>. Codes expire after 10 minutes.
        </p>
        <h2>Working offline</h2>
        <p>After signing in, the program works without internet for up to 7 days after it last reached Matchframe. When that period ends it asks you to connect once.</p>
        <h2>Signed out?</h2>
        <p>
          A computer is signed out when the account's password is changed or reset, the account is disabled, its person leaves the organisation, or someone <Link to="/help/unlinking-a-computer">unlinks the computer</Link>. A program that is already open keeps running and shows a notice; it asks you to sign in the next time it opens.
        </p>
        <h2>Who can sign in a computer</h2>
        <p>Owners, admins and members, once their email address is confirmed. Billing members can't.</p>
        <h2>"This plan allows 1 signed-in computer"</h2>
        <p>
          Each plan allows a number of signed-in production computers. <Link to="/help/unlinking-a-computer">Sign out a computer</Link> you no longer use, or move to a plan with more computers on the Billing &amp; Subscription page. Extra operator positions that connect to the production computer from File → Connection settings don't need their own sign-in.
        </p>
      </>
    ),
  },
  {
    slug: "plans-and-hours",
    category: "billing",
    title: "Plans and auto-director hours",
    summary: "What each plan includes, how hours are measured and what happens at the limit.",
    keywords: "plan hours auto-director allowance limit usage period reset overage free pro studio included",
    body: (
      <>
        <p>Every plan includes the whole program. Plans differ in the auto-director hours included each period, the number of linked computers and the size of the team. Compare them on the <Link to="/pricing">pricing page</Link>.</p>
        <h2>What uses hours</h2>
        <p>Hours are used only while the auto director controls the camera on a live match: automation armed, the director in automatic or assisted mode, a real observer client connected and live telemetry arriving. The program measures this per second and uploads it every few minutes.</p>
        <p>These never use hours: manual and advisory direction, the simulation, demo playback, HUDs, replays, administration, and time when the computer is asleep.</p>
        <h2>Watching your usage</h2>
        <p>The dashboard shows the hours left this period. The Usage page breaks usage down by day and by computer, lists every session with its map and match, and exports CSV.</p>
        <h2>When hours run out</h2>
        <p>Automation that's already running finishes the current map and then hands the camera back to your operator. It's never cut off mid-map. Automatic direction can't be re-armed until hours are added or the next period starts. There are no overage charges.</p>
        <h2>When hours reset</h2>
        <p>
          Included hours renew at the start of each billing period on a paid plan, and each calendar month on the Free plan. They don't roll over. Need more right now? <Link to="/help/buying-hour-packs">Buy an hour pack</Link>.
        </p>
      </>
    ),
  },
  {
    slug: "buying-hour-packs",
    category: "billing",
    title: "Buying hour packs",
    summary: "Top up auto-director hours on any plan without changing your subscription.",
    keywords: "hour pack buy top up credits extra hours expiry 365 days",
    body: (
      <>
        <p>Hour packs add auto-director hours to an organisation on top of its plan. They work on every plan, including Free.</p>
        <h2>Buy a pack</h2>
        <ol>
          <li>Open Billing &amp; Subscription for the organisation.</li>
          <li>
            Under <strong>Buy auto-director hours</strong>, choose <strong>Buy</strong> next to a pack.
          </li>
          <li>Pay on Stripe's checkout page. You return to the billing page, and the hours appear within a few seconds.</li>
        </ol>
        <p>Only owners and billing members can buy, and their email address must be verified.</p>
        <h2>How pack hours are used</h2>
        <ul>
          <li>Pack hours are used after the plan's included hours for the period.</li>
          <li>If you have several packs, the one that expires first is used first.</li>
          <li>Packs are valid for 365 days from purchase. Unused hours expire after that.</li>
        </ul>
        <p>Your packs, and any hours granted by our support team, are listed under <strong>Hour credits</strong> on the billing page with what's left and when they expire.</p>
      </>
    ),
  },
  {
    slug: "invoices-and-billing-portal",
    category: "billing",
    title: "Invoices and the billing portal",
    summary: "Download invoices, update payment details and change or cancel your plan.",
    keywords: "invoice receipt pdf billing portal stripe payment method card cancel change plan tax vat",
    body: (
      <>
        <p>Matchframe uses Stripe for payments. Stripe's customer portal is where you manage payment details, invoices and the subscription.</p>
        <h2>Find your invoices</h2>
        <p>The billing page lists recent invoices with links to view them online or download a PDF. For older invoices and receipts, open the portal.</p>
        <h2>Open the billing portal</h2>
        <ol>
          <li>Open Billing &amp; Subscription for the organisation.</li>
          <li>
            Choose <strong>Manage subscription</strong> (or <strong>Billing details and invoices</strong> if you don't have a subscription). You're taken to Stripe and back again afterwards.
          </li>
        </ol>
        <p>In the portal you can update the card and billing address, download invoices, change plan and cancel.</p>
        <h2>Cancelling</h2>
        <p>
          A cancelled subscription stays active until the end of the period you've paid for, then the organisation moves to the Free plan. Hour packs you bought stay valid until they expire. See the <Link to="/legal/refunds">refund and cancellation policy</Link>.
        </p>
        <h2>Failed payments</h2>
        <p>If a renewal payment fails, Stripe retries it and the plan is marked <em>Payment overdue</em>. Update the payment method in the portal to keep the plan.</p>
      </>
    ),
  },
  {
    slug: "team-roles",
    category: "team",
    title: "Team roles and permissions",
    summary: "Owner, admin, billing and member: what each role can do, and how to invite people.",
    keywords: "roles permissions owner admin billing member invite invitation remove leave team",
    body: (
      <>
        <p>Everyone in an organisation has one role. Owners can change roles on the Team page.</p>
        <div className="table-scroll">
          <table className="doc-table">
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Can do</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Owner</th>
                <td>Everything: plan and payments, members and roles (including other owners), renaming the organisation, linking and unlinking computers.</td>
              </tr>
              <tr>
                <th scope="row">Admin</th>
                <td>Members and invitations (not owners), renaming, linking and unlinking computers, viewing billing and usage. Can't buy or change the plan.</td>
              </tr>
              <tr>
                <th scope="row">Billing</th>
                <td>Plan, payments, hour packs and invoices, and usage. Can't link computers or manage members.</td>
              </tr>
              <tr>
                <th scope="row">Member</th>
                <td>Links computers and sees usage. Can't see billing or manage anyone.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <h2>Invite someone</h2>
        <ol>
          <li>
            On the Team page, under <strong>Invite someone</strong>, enter their email address and choose a role.
          </li>
          <li>
            Choose <strong>Send invitation</strong>. The invitation link expires after 7 days.
          </li>
        </ol>
        <p>Pending invitations count towards the plan's member limit until they're accepted or withdrawn. Every organisation keeps at least one owner.</p>
      </>
    ),
  },
  {
    slug: "unlinking-a-computer",
    category: "team",
    title: "Unlinking a computer",
    summary: "Free up a computer slot or cut off a computer you no longer trust.",
    keywords: "unlink remove computer device revoke slot lost stolen",
    body: (
      <>
        <p>Unlink a computer when you replace it, give it away or no longer want it to use your organisation's hours.</p>
        <ol>
          <li>Open Computers for the organisation.</li>
          <li>
            Choose <strong>Unlink</strong> next to the computer and confirm.
          </li>
        </ol>
        <p>The computer's credential stops working immediately and its slot is freed. The program on that computer keeps working for everything except automatic direction. A licence it had already downloaded expires on its own schedule, at most seven days after it was issued.</p>
        <p>Owners and admins can unlink computers. To use the computer again later, link it again from the program.</p>
      </>
    ),
  },
  {
    slug: "resetting-your-password",
    category: "account",
    title: "Resetting your password",
    summary: "Forgot your password? Get a reset link by email.",
    keywords: "password reset forgot change sign in login locked",
    body: (
      <>
        <h2>Forgot your password</h2>
        <ol>
          <li>
            Open <Link to="/forgot-password">Reset your password</Link> (also linked from the sign-in page).
          </li>
          <li>Enter your account's email address. If an account exists, we email a reset link.</li>
          <li>Open the link within 60 minutes and choose a new password of at least 10 characters.</li>
        </ol>
        <p>Resetting your password signs you out on every device. Sign in again with the new password.</p>
        <h2>Change your password while signed in</h2>
        <p>
          On your <Link to="/account">account page</Link>, enter your current password and the new one. Other browsers and devices are signed out; the one you're using stays signed in.
        </p>
      </>
    ),
  },
  {
    slug: "sessions-and-your-data",
    category: "account",
    title: "Active sessions and downloading your data",
    summary: "See where you're signed in, sign out other devices and export your data.",
    keywords: "sessions devices sign out everywhere revoke security export download data gdpr privacy delete account",
    body: (
      <>
        <h2>Active sessions</h2>
        <p>
          Your <Link to="/account#sessions">account page</Link> lists every browser where you're signed in, with the browser, operating system, IP address and when it was last used. The one you're using is marked <strong>This device</strong>.
        </p>
        <ul>
          <li>
            Choose <strong>Sign out</strong> next to a session to end it.
          </li>
          <li>
            Choose <strong>Sign out all other sessions</strong> if you don't recognise a session, then change your password.
          </li>
        </ul>
        <h2>Download your data</h2>
        <p>
          Choose <strong>Download my data</strong> on your account page to save a JSON file with your profile, memberships and the account data we hold about you.
        </p>
        <h2>Deleting your account</h2>
        <p>
          <Link to="/contact?topic=support">Contact support</Link> from the address on your account. We delete the account and its personal data, except records we must keep by law, such as invoices.
        </p>
      </>
    ),
  },
];

export const helpArticle = (slug: string): HelpArticle | undefined => HELP_ARTICLES.find((a) => a.slug === slug);

/** Case-insensitive match against title, summary and keywords. */
export function searchHelp(query: string): HelpArticle[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return HELP_ARTICLES;
  return HELP_ARTICLES.filter((a) => {
    const hay = `${a.title} ${a.summary} ${a.keywords}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
