import type { ReactNode } from "react";
import type { SiteInfo } from "../api/types.ts";
import { Link } from "../router.tsx";

/**
 * Terms and policies. Company details always come from GET /v1/site (never hard-coded here), so the
 * operator can set them on the server. The text is generic SaaS wording for the website, the
 * account services and the Matchframe program.
 */
export interface LegalDoc {
  slug: string;
  title: string;
  short: string;
  summary: string;
  render: (s: SiteInfo) => ReactNode;
}

function ContactLine({ s }: { s: SiteInfo }) {
  return (
    <>
      through our <Link to="/contact?topic=legal">contact form</Link>
      {s.supportEmail ? (
        <>
          {" "}
          or by email to <a href={`mailto:${s.supportEmail}`}>{s.supportEmail}</a>
        </>
      ) : null}
      {s.address ? <>, or by post to {s.companyName}, {s.address}</> : null}
    </>
  );
}

const terms: LegalDoc = {
  slug: "terms",
  title: "Terms of Service",
  short: "Terms",
  summary: "The agreement that covers your account, subscriptions, auto-director hours and use of the website.",
  render: (s) => (
    <>
      <p>
        These Terms of Service ("Terms") are an agreement between you and {s.companyName} ("we", "us", "our"). They govern your use of the {s.websiteName} website, your account, the organisations you create or join, subscriptions and hour packs, and the online services the {s.websiteName} program uses (together, the "Service"). Your use of the {s.websiteName} program itself is also governed by the <Link to="/legal/eula">End User Licence Agreement</Link>.
      </p>
      <p>By creating an account or using the Service you accept these Terms. If you use the Service on behalf of an organisation, you confirm that you're authorised to accept these Terms for it, and "you" includes that organisation.</p>

      <h2>1. Eligibility and accounts</h2>
      <p>You must be at least 18 years old, or the age of majority where you live, and able to enter into a binding contract. The Service is intended for business and professional use by production teams, organisers and leagues.</p>
      <p>Keep your sign-in details secure and accurate. You're responsible for activity under your account. Tell us promptly if you believe your account has been compromised. You can review and end active sessions from your account page.</p>

      <h2>2. Organisations and roles</h2>
      <p>Plans, auto-director hours, linked computers and team members belong to an organisation. Owners control the organisation and decide who joins it and which role they have. Billing, admin and member roles have the permissions described in our help centre. The organisation's owners are responsible for the actions of its members within the Service.</p>

      <h2>3. Plans, payment and renewal</h2>
      <ul>
        <li>Paid plans are billed monthly in advance and renew automatically at the end of each billing period until cancelled.</li>
        <li>Payments are processed by Stripe, our payment processor. By paying, you also accept Stripe's terms for the payment. We don't receive or store your full card details.</li>
        <li>Prices are shown on the pricing page and at checkout. Any applicable taxes are shown at checkout and added to the price where required.</li>
        <li>We may change prices or plan contents. We'll give you at least 30 days' notice of a price increase for an active subscription, and it applies from your next billing period. You can cancel before it takes effect.</li>
        <li>If a payment fails, Stripe may retry it. If it still can't be collected, we may move the organisation to the Free plan or suspend paid features.</li>
      </ul>

      <h2>4. Auto-director hours</h2>
      <p>
        Auto-director hours measure the time in which the program's automatic director controls the observer camera on a live match. The program measures that time and uploads it to the Service; the usage records held by the Service are the basis for your allowance. Included hours renew each billing period (each calendar month on the Free plan) and don't roll over. Hour packs are valid for 365 days from purchase and are used after included hours, earliest expiry first.
      </p>
      <p>We don't charge for usage beyond your hours. When an organisation runs out of hours, automation that is already running continues to the end of the current map and automatic direction can't then be re-armed until hours are added or the next period begins. The other features of the program aren't affected.</p>

      <h2>5. Cancellation and refunds</h2>
      <p>
        You can cancel a subscription at any time in the customer portal. The plan stays active until the end of the paid period. Refunds are handled under our <Link to="/legal/refunds">Refund and Cancellation Policy</Link>.
      </p>

      <h2>6. Acceptable use</h2>
      <p>
        You must use the Service lawfully and in line with our <Link to="/legal/acceptable-use">Acceptable Use Policy</Link>. In particular, you must not attempt to bypass licence checks or usage metering, or interfere with the Service or other customers.
      </p>

      <h2>7. Your content and data</h2>
      <p>
        You keep all rights in the information you submit, such as organisation names and messages. You give us a limited licence to host and process it only to provide, secure and support the Service. Broadcast data such as game telemetry, graphics and recordings stays on your computers and isn't uploaded to the Service. How we handle personal data is described in our <Link to="/legal/privacy">Privacy Policy</Link>.
      </p>
      <p>You're responsible for having the rights you need for what you broadcast, including match footage, team and player names and logos, music and sponsor material.</p>

      <h2>8. Third-party products</h2>
      <p>The program works with third-party products such as Counter-Strike 2 and OBS Studio, which are provided by their owners under their own terms. We're not affiliated with or endorsed by Valve Corporation. Changes to third-party products may affect how the program works with them.</p>

      <h2>9. Availability and changes</h2>
      <p>We work to keep the Service available and secure, but we don't guarantee that it will be uninterrupted or error-free, and we may carry out maintenance. The program keeps working offline within its licence window. We may improve, change or discontinue features; if we remove a material part of a paid plan, we'll tell you in advance and you may cancel.</p>

      <h2>10. Suspension and termination</h2>
      <p>You can stop using the Service and ask us to close your account at any time. We may suspend or terminate access if you seriously or repeatedly breach these Terms, if required by law, or to protect the Service or others. Where reasonable, we'll tell you first and give you a chance to fix the problem. Sections that by their nature should survive termination will survive.</p>

      <h2>11. Disclaimers</h2>
      <p>
        Except as expressly stated in these Terms, the Service is provided "as is" and "as available". To the extent permitted by law, we disclaim implied warranties of merchantability, fitness for a particular purpose and non-infringement. Live production involves risk: you remain responsible for monitoring your broadcast output, and automatic direction and camera control depend on your setup and the game build. Nothing in these Terms excludes rights you have under consumer law that can't be excluded.
      </p>

      <h2>12. Limitation of liability</h2>
      <p>
        To the extent permitted by law, neither party is liable for indirect, incidental, special or consequential losses, or for loss of profits, revenue, audience, sponsorship or data, arising from the Service. Our total liability arising out of or relating to the Service in any 12-month period is limited to the amounts you paid us for the Service in that period. These limits don't apply to liability that can't be limited by law, such as for death or personal injury caused by negligence, or for fraud.
      </p>

      <h2>13. Indemnity</h2>
      <p>You'll indemnify us against third-party claims arising from content you broadcast or submit, or from your breach of these Terms or the law, except to the extent caused by us.</p>

      <h2>14. Changes to these Terms</h2>
      <p>We may update these Terms. For material changes we'll give notice on the website or by email before they take effect. If you keep using the Service after the effective date, the updated Terms apply. If you don't agree, you can cancel and stop using the Service.</p>

      <h2>15. Governing law</h2>
      <p>These Terms are governed by the laws of {s.jurisdiction}, and the courts of {s.jurisdiction} have jurisdiction over disputes, except where consumer law gives you the right to bring proceedings where you live.</p>

      <h2>16. General</h2>
      <p>These Terms, together with the policies they refer to, are the whole agreement between us about the Service. If a provision is found unenforceable, the rest remains in effect. A failure to enforce a provision isn't a waiver. You may not transfer your rights under these Terms without our consent; we may transfer ours as part of a reorganisation or sale of our business, with notice to you.</p>

      <h2>17. Contact</h2>
      <p>
        Questions about these Terms? Contact {s.companyName} <ContactLine s={s} />.
      </p>
    </>
  ),
};

const privacy: LegalDoc = {
  slug: "privacy",
  title: "Privacy Policy",
  short: "Privacy",
  summary: "What personal data we collect, why, who we share it with, how long we keep it and your rights.",
  render: (s) => (
    <>
      <p>
        This policy explains how {s.companyName} ("we", "us") handles personal data when you use the {s.websiteName} website, your account and the online services used by the {s.websiteName} program. We are the controller of this personal data.
      </p>

      <h2>1. Data we collect</h2>
      <ul>
        <li>
          <strong>Account data:</strong> name, email address, password (stored only as a salted hash), email verification status, and when you signed up and last signed in.
        </li>
        <li>
          <strong>Session and security data:</strong> for each signed-in browser, its IP address, user agent and timestamps; rate-limiting and audit records of security-relevant actions.
        </li>
        <li>
          <strong>Organisation data:</strong> organisation names, members, roles and invitations (including the email addresses of people you invite).
        </li>
        <li>
          <strong>Linked computers and usage:</strong> the name, platform and program version of each linked computer, when it was linked and last seen, and records of when and for how long automatic direction ran, with the map and match label sent by the program.
        </li>
        <li>
          <strong>Billing data:</strong> plan and subscription status, hour credits, invoices and a reference to your customer record at Stripe. Card details are collected and stored by Stripe, not by us.
        </li>
        <li>
          <strong>Communications:</strong> messages you send through the contact form, and a log of the emails we send you (recipient, subject and delivery state).
        </li>
      </ul>
      <p>We don't receive game telemetry, HUD content, recordings or replays: these stay on your computers. We don't use analytics, advertising or tracking cookies.</p>

      <h2>2. Why we use it</h2>
      <ul>
        <li>
          <strong>To provide the Service</strong> (performance of our contract with you): accounts, organisations, linking computers, licences, measuring auto-director hours, payments and support.
        </li>
        <li>
          <strong>To keep the Service secure</strong> (our legitimate interests): preventing abuse and fraud, rate limiting, audit trails and investigating incidents.
        </li>
        <li>
          <strong>To communicate with you</strong> (contract and legitimate interests): service emails such as verification, password resets, invitations, receipts and important changes. We don't send marketing emails without your consent.
        </li>
        <li>
          <strong>To meet legal obligations:</strong> for example tax and accounting records for invoices.
        </li>
      </ul>

      <h2>3. Who we share it with</h2>
      <p>We don't sell personal data. We share it only with service providers who process it for us under contract and appropriate safeguards:</p>
      <ul>
        <li>Stripe, our payment processor, for checkout, subscriptions, invoices and the customer portal;</li>
        <li>our hosting provider, which runs the servers and database for the Service;</li>
        <li>our email delivery provider, which sends service emails;</li>
        <li>professional advisers, and authorities where the law requires it;</li>
        <li>a buyer or successor if our business is reorganised or sold, subject to this policy.</li>
      </ul>
      <p>Members of your organisation can see your name, email address and role. Our staff can access account data when needed to support you or secure the Service; such access is limited by role and audited.</p>

      <h2>4. International transfers</h2>
      <p>Our providers may process data in other countries. Where data is transferred outside your region, we rely on appropriate safeguards such as adequacy decisions or standard contractual clauses.</p>

      <h2>5. How long we keep it</h2>
      <ul>
        <li>Account and organisation data: while your account exists. When you ask us to delete your account, we delete or anonymise its personal data within 30 days.</li>
        <li>Sessions: until you sign out or they expire (after 30 days of inactivity at most).</li>
        <li>Usage records: for the billing period they belong to and as long as needed to resolve billing questions.</li>
        <li>Invoices and payment records: as long as tax and accounting law requires.</li>
        <li>Contact messages and email logs: as long as needed to handle your request, and then for up to 24 months.</li>
        <li>Backups are overwritten on a rolling basis.</li>
      </ul>

      <h2>6. Security</h2>
      <p>
        We protect personal data with technical and organisational measures, including encrypted connections, hashed passwords and tokens, role-based access and audit logs. See our <Link to="/security">security overview</Link>.
      </p>

      <h2>7. Your rights</h2>
      <p>Depending on where you live, you may have the right to access your data, correct it, delete it, restrict or object to its processing, and receive it in a portable format. You can download a copy of your account data from your account page at any time. To exercise your other rights, contact us as described below. You also have the right to complain to your data protection authority.</p>

      <h2>8. Children</h2>
      <p>The Service isn't directed at children under 16 and we don't knowingly collect their personal data.</p>

      <h2>9. Changes</h2>
      <p>We'll update this policy when our practices change, and tell you about material changes before they take effect.</p>

      <h2>10. Contact</h2>
      <p>
        To ask a question or exercise your rights, contact {s.companyName} <ContactLine s={s} />.
      </p>
    </>
  ),
};

const cookies: LegalDoc = {
  slug: "cookies",
  title: "Cookie Policy",
  short: "Cookies",
  summary: "We use one essential cookie to keep you signed in, and no tracking cookies.",
  render: (s) => (
    <>
      <p>This policy explains the cookies and similar technologies used by the {s.websiteName} website.</p>

      <h2>1. Essential cookie only</h2>
      <p>We use a single cookie, which is strictly necessary to keep you signed in. It doesn't track you across websites and isn't used for analytics or advertising, so we don't ask for consent or show a cookie banner.</p>
      <div className="table-scroll">
        <table className="doc-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Purpose</th>
              <th scope="col">Duration</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>mf_session</code>
              </td>
              <td>Keeps you signed in. Set when you sign in; HttpOnly, so scripts can't read it; sent only to this website.</td>
              <td>Up to 30 days, or until you sign out</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>2. Local storage</h2>
      <p>The website also stores two small preferences in your browser's local storage. They never leave your browser:</p>
      <ul>
        <li>
          <code>matchframe.signedIn</code>: remembers that this browser was signed in, so public pages can show your dashboard link.
        </li>
        <li>
          <code>matchframe.lastOrgId</code>: remembers which organisation you opened last.
        </li>
      </ul>

      <h2>3. No third-party cookies</h2>
      <p>We don't load analytics, advertising, social media or other third-party scripts. When you pay, you're taken to Stripe's checkout and portal pages, which are governed by Stripe's own cookie and privacy policies.</p>

      <h2>4. Managing cookies</h2>
      <p>You can delete or block cookies in your browser settings. If you block the session cookie, you won't be able to sign in.</p>

      <h2>5. Contact</h2>
      <p>
        Questions? Contact {s.companyName} <ContactLine s={s} />.
      </p>
    </>
  ),
};

const refunds: LegalDoc = {
  slug: "refunds",
  title: "Refund and Cancellation Policy",
  short: "Refunds",
  summary: "How to cancel a subscription, what happens to hours, and when refunds are available.",
  render: (s) => (
    <>
      <p>This policy explains how cancellations and refunds work for subscriptions and hour packs bought from {s.companyName}. It forms part of our <Link to="/legal/terms">Terms of Service</Link>.</p>

      <h2>1. Cancelling a subscription</h2>
      <ul>
        <li>Owners and billing members can cancel at any time in the customer portal (Billing &amp; Subscription → Manage subscription).</li>
        <li>The subscription stays active until the end of the current billing period and isn't renewed. The organisation then moves to the Free plan.</li>
        <li>Unused included hours don't carry over after the period ends. Hour packs remain valid until their expiry date.</li>
      </ul>

      <h2>2. Changing plans</h2>
      <p>You can switch plans in the customer portal. Upgrades take effect immediately and Stripe may charge a prorated amount for the rest of the period. Downgrades take effect as shown in the portal.</p>

      <h2>3. Subscription refunds</h2>
      <p>Subscription fees are charged in advance for each period and are generally not refundable for periods that have started, including partly used periods. We'll refund a charge where:</p>
      <ul>
        <li>you were charged in error, for example twice for the same period;</li>
        <li>a renewal was charged after you had validly cancelled; or</li>
        <li>the Service was substantially unavailable for a significant part of the period because of a fault on our side.</li>
      </ul>

      <h2>4. Hour pack refunds</h2>
      <p>If you haven't used any hours from a pack, you can ask for a full refund within 14 days of purchase. Once hours from a pack have been used, or after 14 days, packs are non-refundable. Expired hours aren't refunded.</p>

      <h2>5. Your statutory rights</h2>
      <p>Nothing in this policy affects rights you have under consumer protection law that can't be excluded. Where the law gives you a right to withdraw from a purchase, we'll honour it.</p>

      <h2>6. How to ask for a refund</h2>
      <p>
        Contact us <ContactLine s={s} /> with the organisation name and the invoice number. Approved refunds go back to the original payment method through Stripe; your bank may take several days to show them.
      </p>

      <h2>7. Chargebacks</h2>
      <p>Please contact us before disputing a charge with your bank; we can usually resolve problems faster. While a dispute is open, we may suspend paid features of the affected organisation.</p>
    </>
  ),
};

const acceptableUse: LegalDoc = {
  slug: "acceptable-use",
  title: "Acceptable Use Policy",
  short: "Acceptable use",
  summary: "What you may not do with the website, your account and the program.",
  render: (s) => (
    <>
      <p>
        This policy applies to everyone who uses the {s.websiteName} website, account services and program. It forms part of our <Link to="/legal/terms">Terms of Service</Link> and the <Link to="/legal/eula">End User Licence Agreement</Link>.
      </p>

      <h2>1. Fair play</h2>
      <ul>
        <li>Don't use the program or any data from the observer feed to give players or teams an advantage during a match, for example by passing on positions or utility ("ghosting").</li>
        <li>Don't use the program to read game memory, inject code, evade anti-cheat systems or break the rules of a tournament or game publisher.</li>
      </ul>

      <h2>2. Licences and metering</h2>
      <ul>
        <li>Don't bypass, disable or tamper with licence checks, usage metering or plan limits, or report false usage.</li>
        <li>Don't share accounts or link computers outside your organisation to avoid plan limits.</li>
        <li>Don't resell or provide the Service to third parties unless we've agreed to it in writing.</li>
      </ul>

      <h2>3. Security and integrity</h2>
      <ul>
        <li>Don't probe, scan or test the Service for vulnerabilities without our permission, except as described in our responsible disclosure guidance on the <Link to="/security">security page</Link>.</li>
        <li>Don't access accounts or data that aren't yours, or try to get around access controls or rate limits.</li>
        <li>Don't upload malware, overload the Service or interfere with other customers.</li>
        <li>Don't scrape the website or use the API in ways that aren't intended for the program and this website.</li>
      </ul>

      <h2>4. Content and conduct</h2>
      <ul>
        <li>Don't use the Service for anything unlawful, or to infringe the intellectual property, privacy or other rights of others, including broadcast rights.</li>
        <li>Don't send spam or unwanted invitations, or use the contact form to harass our team.</li>
        <li>Don't show content in HUDs or graphics that is hateful, harassing or unlawful.</li>
      </ul>

      <h2>5. Enforcement</h2>
      <p>We may investigate suspected breaches and remove access, suspend or close accounts or organisations, and cooperate with authorities where required. Where appropriate, we'll warn you first and give you a chance to put things right.</p>

      <h2>6. Reporting</h2>
      <p>
        To report a breach of this policy, contact {s.companyName} <ContactLine s={s} />.
      </p>
    </>
  ),
};

const eula: LegalDoc = {
  slug: "eula",
  title: "End User Licence Agreement",
  short: "EULA",
  summary: "The licence under which you may install and use the Matchframe program for Windows.",
  render: (s) => (
    <>
      <p>
        This End User Licence Agreement ("Agreement") is between you and {s.companyName} ("we", "us") and covers the {s.websiteName} program for Windows, including updates, documentation and the HUD packages and other materials we provide with it (the "Program"). By installing or using the Program you accept this Agreement. If you don't accept it, don't install or use the Program.
      </p>

      <h2>1. Licence</h2>
      <p>We grant you a non-exclusive, non-transferable, revocable licence to install and use the Program on computers that you own or control, to produce your own broadcasts and those of the organisations you work for, in line with this Agreement, our <Link to="/legal/terms">Terms of Service</Link> and the limits of your organisation's plan.</p>

      <h2>2. Restrictions</h2>
      <p>Except as expressly allowed by this Agreement or by law that can't be excluded, you must not:</p>
      <ul>
        <li>copy, modify, distribute, sell, rent or sublicense the Program;</li>
        <li>reverse engineer, decompile or disassemble the Program;</li>
        <li>bypass, disable or interfere with its licence checks, usage metering or safety features;</li>
        <li>remove or alter copyright, trademark or other notices; or</li>
        <li>
          use the Program in breach of our <Link to="/legal/acceptable-use">Acceptable Use Policy</Link>.
        </li>
      </ul>

      <h2>3. Online features</h2>
      <p>Most of the Program works offline without an account. Automatic direction on live matches requires the computer to be linked to an organisation with auto-director hours. A linked Program periodically contacts our servers to refresh its signed licence and upload usage records (when and for how long automatic direction ran, with the map and match label). A licence remains usable offline for a limited period after it was issued. When hours run out, automation already running continues to the end of the current map.</p>

      <h2>4. Your responsibilities</h2>
      <p>You're responsible for your production setup and for monitoring your broadcast. Automatic camera control is only available after the in-program setup tests pass, and depends on third-party software and game builds outside our control. Use the manual takeover and emergency stop whenever needed.</p>

      <h2>5. Third-party software and products</h2>
      <p>The Program includes open-source components that are licensed under their own terms, listed in the Program's third-party notices. The Program works with third-party products such as Counter-Strike 2 and OBS Studio, which you obtain and use under their owners' terms. We're not affiliated with or endorsed by Valve Corporation.</p>

      <h2>6. Updates</h2>
      <p>We may provide updates that fix problems, add features or keep the Program compatible with the online services. Some online features may require a recent version.</p>

      <h2>7. Ownership</h2>
      <p>The Program is licensed, not sold. We and our licensors keep all rights in it not expressly granted to you. Your data, graphics and recordings remain yours and stay on your computers unless you choose to share them.</p>

      <h2>8. Disclaimer</h2>
      <p>To the extent permitted by law, the Program is provided "as is", without warranties of any kind, including implied warranties of merchantability, fitness for a particular purpose and non-infringement. We don't warrant that the Program will be error-free or work with every game build or hardware setup.</p>

      <h2>9. Limitation of liability</h2>
      <p>To the extent permitted by law, we're not liable for indirect, incidental, special or consequential losses, or for loss of profits, revenue, audience, sponsorship or data, arising from the Program. Our total liability under this Agreement is limited as set out in the Terms of Service. Nothing in this Agreement limits liability that can't be limited by law.</p>

      <h2>10. Term and termination</h2>
      <p>This Agreement applies until it ends. It ends automatically if you breach it and don't fix the breach promptly after we ask you to. When it ends, you must stop using and uninstall the Program. Sections 7 to 12 survive termination.</p>

      <h2>11. Export and sanctions</h2>
      <p>You must comply with export control and sanctions laws that apply to your use of the Program.</p>

      <h2>12. Governing law and contact</h2>
      <p>
        This Agreement is governed by the laws of {s.jurisdiction}. Questions about it? Contact {s.companyName} <ContactLine s={s} />.
      </p>
    </>
  ),
};

export const LEGAL_DOCS: LegalDoc[] = [terms, privacy, cookies, refunds, acceptableUse, eula];

export const legalDoc = (slug: string): LegalDoc | undefined => LEGAL_DOCS.find((d) => d.slug === slug);
