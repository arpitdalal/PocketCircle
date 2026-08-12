import { LEGAL_DOCUMENTS } from "@pocketcircle/domain";
import { LegalDocument, LegalList, LegalSection } from "~/components/legal-document.js";

export default function Privacy() {
  return (
    <LegalDocument
      title="Privacy Policy"
      summary="This Policy explains what PocketCircle collects, why it is used, when it is shared, and the choices available to you."
      effectiveDate={LEGAL_DOCUMENTS.privacy.effectiveDate}
    >
      <LegalSection title="1. Information we collect">
        <LegalList>
          <li>
            <strong className="text-foreground">Google Account information:</strong> Google&apos;s
            stable account identifier, email address, Display Name, and Profile Picture used to
            create and secure your PocketCircle account.
          </li>
          <li>
            <strong className="text-foreground">Profile and settings:</strong> Display Name, default
            Currency, onboarding state, legal-document acceptance, analytics consent, and Account
            Deletion state.
          </li>
          <li>
            <strong className="text-foreground">Circle content:</strong> Circle names, colors,
            membership, Invitations, Categories, Transactions, dates, exact amounts, titles,
            optional notes, who recorded or paid, archives, and audit History.
          </li>
          <li>
            <strong className="text-foreground">Communications:</strong> feedback you submit and
            operational email-delivery records. Feedback message text is sent by email and is not
            stored in the PocketCircle database.
          </li>
          <li>
            <strong className="text-foreground">Technical information:</strong> session data,
            timestamps, browser and device details, network information, error diagnostics, and
            coarse feature-usage events when product analytics are enabled.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="2. How we use information">
        <LegalList>
          <li>authenticate you and maintain your session;</li>
          <li>create your Personal Circle and provide collaborative Circle features;</li>
          <li>
            enforce permissions, preserve audit History, prevent abuse, and protect the service;
          </li>
          <li>send Welcome, Invitation, Account Deletion, and support-related emails;</li>
          <li>diagnose errors, maintain reliability, and respond to feedback; and</li>
          <li>understand feature usage through privacy-limited analytics when enabled.</li>
        </LegalList>
        <p>
          PocketCircle does not sell personal information, use it for targeted advertising, or use
          Transaction titles, notes, exact amounts, or feedback text for product analytics.
        </p>
      </LegalSection>

      <LegalSection title="3. Shared Circles">
        <p>
          Current Members can see Circle content according to their permissions. Owners can manage
          membership and may see pending Invitation details. Audit History identifies who performed
          relevant actions so shared records remain understandable and accountable.
        </p>
        <p>
          Other Members may create records that identify you as Recorded By or Paid By. Leaving a
          Circle or deleting your account does not erase shared records from that Circle. After
          Account Deletion, a frozen Display Name may remain with historical activity while your
          Profile Picture and live account connection are removed.
        </p>
      </LegalSection>

      <LegalSection title="4. Service providers">
        <p>PocketCircle currently uses:</p>
        <LegalList>
          <li>
            <strong className="text-foreground">Google</strong> for sign-in and account identity;
          </li>
          <li>
            <strong className="text-foreground">Convex</strong> for the application database,
            backend functions, authentication component, and realtime updates;
          </li>
          <li>
            <strong className="text-foreground">Cloudflare</strong> to host and deliver the web
            application;
          </li>
          <li>
            <strong className="text-foreground">Resend</strong> to deliver transactional and support
            email;
          </li>
          <li>
            <strong className="text-foreground">Sentry</strong> for operational error monitoring and
            masked, error-triggered Session Replay; and
          </li>
          <li>
            <strong className="text-foreground">PostHog</strong> for limited product analytics only
            after you opt in.
          </li>
        </LegalList>
        <p>
          These providers process information on PocketCircle&apos;s behalf under their own privacy
          terms. Information may be processed outside your province, state, or country and may be
          subject to the laws of those locations.
        </p>
      </LegalSection>

      <LegalSection title="5. Analytics and operational monitoring">
        <p>
          Product analytics are off by default for every user, regardless of location. PostHog is
          not initialized until you explicitly enable product analytics in Settings → Privacy. Once
          enabled, PostHog receives allowlisted, coarse events such as feature names and workflow
          outcomes—not financial content or free text. You can withdraw consent at any time by
          turning product analytics off; capture stops and PostHog&apos;s local analytics state is
          cleared. You can opt in again later. PostHog Session Replay is disabled.
        </p>
        <p>
          Sentry operational monitoring remains enabled regardless of that preference. Normal
          sessions are not sampled for replay. A replay may be captured when an error occurs, with
          on-screen text masked and media blocked. Error reports can include technical context
          needed to diagnose the failure, but PocketCircle does not intentionally attach financial
          content to them.
        </p>
      </LegalSection>

      <LegalSection title="6. Cookies and local storage">
        <p>
          PocketCircle and its authentication provider use cookies or equivalent browser storage to
          keep you signed in and protect account access. After you opt in, PostHog may use local
          storage for your analytics preference and analytics state. Browser storage is also used
          for limited user interface state. Blocking required storage may prevent the service from
          working.
        </p>
      </LegalSection>

      <LegalSection title="7. When information may be disclosed">
        <p>Information may be disclosed:</p>
        <LegalList>
          <li>to other Circle Members as described above;</li>
          <li>to service providers that operate PocketCircle;</li>
          <li>when you direct or consent to the disclosure;</li>
          <li>to investigate abuse, protect users, or secure the service; or</li>
          <li>when reasonably required by law, legal process, or a valid government request.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="8. Retention and Account Deletion">
        <p>
          PocketCircle keeps information while your account is active and as needed to provide and
          secure the service. Operational records may be kept for a limited period for reliability,
          abuse prevention, dispute handling, or legal obligations. Retention periods may differ
          across service providers.
        </p>
        <p>
          You can request Account Deletion in Settings. After email verification, PocketCircle
          removes your login and profile, deletes eligible Circles you solely control, revokes
          relevant pending Invitations, and removes user-scoped operational records through a
          bounded cleanup process. Shared-Circle Transaction and audit records remain for other
          Members with frozen Display Name attribution and without your Profile Picture.
        </p>
      </LegalSection>

      <LegalSection title="9. Your choices and requests">
        <LegalList>
          <li>Update your Display Name and privacy preference in Settings.</li>
          <li>Export Circle Transactions to CSV where Export is available.</li>
          <li>Leave eligible shared Circles or ask an Owner to correct shared records.</li>
          <li>Request Account Deletion in Settings.</li>
          <li>
            Contact us to ask about access, correction, deletion, consent withdrawal, or a privacy
            concern. Some requests may be limited by shared-record integrity or legal obligations.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="10. Security">
        <p>
          PocketCircle uses access controls, server-side authorization, encrypted network
          connections, scoped provider credentials, and data-minimization measures appropriate to an
          early-stage service. No system is perfectly secure, so you should use a protected Google
          Account and avoid entering unnecessary sensitive information.
        </p>
      </LegalSection>

      <LegalSection title="11. Children">
        <p>
          PocketCircle is not directed to children under 13. If you believe a child provided
          personal information without appropriate consent, contact us so the situation can be
          reviewed.
        </p>
      </LegalSection>

      <LegalSection title="12. Changes to this Policy">
        <p>
          This Policy may change as PocketCircle and its providers change. Material changes will be
          presented in a reasonably prominent way and renewed consent will be requested when
          required. The effective date at the top identifies the current version.
        </p>
      </LegalSection>
    </LegalDocument>
  );
}
