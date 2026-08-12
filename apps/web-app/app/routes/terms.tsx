import { LEGAL_DOCUMENTS } from "@pocketcircle/domain";
import { LegalDocument, LegalList, LegalSection } from "~/components/legal-document.js";

export default function Terms() {
  return (
    <LegalDocument
      title="Terms & Conditions"
      summary="These Terms govern your use of the PocketCircle beta. By continuing with Google or otherwise using PocketCircle, you agree to them."
      effectiveDate={LEGAL_DOCUMENTS.terms.effectiveDate}
    >
      <LegalSection title="1. The service">
        <p>
          PocketCircle is a collaborative record-keeping tool for tracking Expenses and Income in
          personal and shared Circles. It is not a bank, payment processor, accounting service,
          investment adviser, or financial adviser. PocketCircle does not move money, settle debts,
          verify that a Transaction occurred, or determine what anyone owes.
        </p>
        <p>
          You remain responsible for your financial decisions, records, taxes, reporting duties, and
          agreements with other Circle Members.
        </p>
      </LegalSection>

      <LegalSection title="2. Eligibility and your account">
        <LegalList>
          <li>You must be legally able to agree to these Terms.</li>
          <li>
            If you are under the age of majority where you live, use PocketCircle only with a parent
            or legal guardian&apos;s permission.
          </li>
          <li>
            You sign in through Google and must provide accurate account information. You are
            responsible for protecting access to your Google Account and devices.
          </li>
          <li>
            You may not impersonate another person, share access unlawfully, or create an account
            for someone without permission.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="3. Shared Circles and your content">
        <p>
          Content you add to a shared Circle—including Transaction details, Categories, and Circle
          activity—can be viewed by current Members according to their permissions. Other Members
          may add records that identify you as the person who paid or recorded a Transaction.
        </p>
        <p>
          You keep any rights you have in content you submit. You give PocketCircle a limited
          permission to host, process, copy, and display that content only as needed to operate,
          secure, support, and improve the service. Only submit information you are authorized to
          share, and avoid unnecessary sensitive information in free-text fields.
        </p>
        <p>
          PocketCircle preserves audit history so Members can understand changes. Editing,
          archiving, leaving a Circle, or deleting your account may not remove records or frozen
          attribution that form part of another Member&apos;s shared Circle history.
        </p>
      </LegalSection>

      <LegalSection title="4. Acceptable use">
        <p>You must not:</p>
        <LegalList>
          <li>use PocketCircle for unlawful, fraudulent, abusive, or deceptive activity;</li>
          <li>
            probe, bypass, or interfere with authentication, permissions, rate limits, or security;
          </li>
          <li>upload malicious code or disrupt the service or its providers;</li>
          <li>
            scrape, reverse engineer, or automate access except where applicable law permits it;
          </li>
          <li>
            violate another person&apos;s privacy, intellectual-property rights, or other rights; or
          </li>
          <li>use the service in a way that creates unreasonable operational risk.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="5. Beta service and availability">
        <p>
          PocketCircle is an early beta. Features may be incomplete, change, break, or be removed.
          Service limits may change as usage grows. We may pause or restrict access to maintain the
          service, address security or legal issues, prevent abuse, or protect users and data.
        </p>
        <p>
          Keep independent copies of records you cannot afford to lose. Circle CSV Export is
          available for portability, but it is not a substitute for your own accounting records or
          backups.
        </p>
      </LegalSection>

      <LegalSection title="6. Account Deletion">
        <p>
          You can request Account Deletion from Settings. Deletion requires email verification and
          may require you to archive or transfer eligible Circles first. Deletion removes your login
          and profile and starts cleanup of data you exclusively control.
        </p>
        <p>
          Shared records may retain a frozen Display Name and activity attribution so remaining
          Members do not lose the meaning of their Transaction and Circle histories. The Privacy
          Policy explains this in more detail.
        </p>
      </LegalSection>

      <LegalSection title="7. Third-party services">
        <p>
          PocketCircle relies on third-party services for authentication, hosting, database, email,
          operational monitoring, and optional product analytics. Their availability and processing
          are governed by their own terms and policies. See the Privacy Policy for the providers
          currently used and the information processed by them.
        </p>
      </LegalSection>

      <LegalSection title="8. Disclaimers">
        <p>
          To the maximum extent permitted by law, PocketCircle is provided “as is” and “as
          available,” without warranties of uninterrupted operation, accuracy, fitness for a
          particular purpose, merchantability, or non-infringement. We do not guarantee that user
          content is correct, complete, recoverable, or suitable for legal, tax, or accounting use.
        </p>
        <p>Nothing in these Terms excludes warranties or rights that cannot legally be excluded.</p>
      </LegalSection>

      <LegalSection title="9. Limitation of liability">
        <p>
          To the maximum extent permitted by law, PocketCircle and its operator will not be liable
          for indirect, incidental, special, consequential, exemplary, or punitive damages, or for
          lost profits, revenues, data, goodwill, or opportunities arising from use of the service.
          Where liability cannot be excluded, it will be limited to the minimum amount permitted by
          applicable law.
        </p>
      </LegalSection>

      <LegalSection title="10. Changes and termination">
        <p>
          We may update these Terms as PocketCircle changes. Material changes will be presented in a
          reasonably prominent way before they apply when required. Continued use after an update
          takes effect means you accept the revised Terms.
        </p>
        <p>
          You may stop using PocketCircle at any time. We may suspend or terminate access when
          reasonably necessary for security, abuse prevention, legal compliance, or a serious breach
          of these Terms.
        </p>
      </LegalSection>
    </LegalDocument>
  );
}
