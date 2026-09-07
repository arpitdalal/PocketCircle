import { MCP_RESOURCE_URI, POCKETCIRCLE_SUPPORT_EMAIL } from "@pocketcircle/domain";
import { href, Link } from "react-router";
import { LegalDocument, LegalList, LegalSection } from "~/components/legal-document.js";

export default function Support() {
  return (
    <LegalDocument
      title="Support"
      summary="Help connecting PocketCircle, fixing AI assistant access, and reaching the maintainer. Do not email passwords, auth codes, tokens, or personal financial exports."
      dateLabel="Updated"
      effectiveDate="September 7, 2026"
    >
      <LegalSection title="Contact">
        <p>
          Email{" "}
          <a
            href={`mailto:${POCKETCIRCLE_SUPPORT_EMAIL}`}
            className="font-medium text-primary underline underline-offset-4"
          >
            {POCKETCIRCLE_SUPPORT_EMAIL}
          </a>
          . This is the public support address for PocketCircle, including ChatGPT and Codex plugin
          questions.
        </p>
      </LegalSection>

      <LegalSection title="Connect an AI assistant">
        <LegalList>
          <li>
            Sign in at{" "}
            <Link
              to={href("/signin")}
              className="font-medium text-primary underline underline-offset-4"
            >
              pocketcircle.app/signin
            </Link>{" "}
            with Google.
          </li>
          <li>
            Open <strong className="text-foreground">Connections</strong> from the account menu.
            Copy the MCP server URL (<code className="text-foreground">{MCP_RESOURCE_URI}</code>
            ).
          </li>
          <li>
            In your assistant (ChatGPT, Codex, Claude, Cursor, or another MCP client), add a remote
            MCP server and paste that URL. Leave Client ID and secrets empty if the client asks.
          </li>
          <li>
            When PocketCircle opens, finish Google sign-in if needed, choose Circles and
            permissions, then Allow. The connection appears under Connections — revoke anytime.
          </li>
        </LegalList>
        <p>
          Directory listing availability depends on the host&apos;s review and publication process.
          You can still connect directly from an assistant with the MCP URL above before a public
          directory listing is live. Installing the package from a local marketplace is for local
          testing and does not publish PocketCircle or prove ChatGPT web availability.
        </p>
      </LegalSection>

      <LegalSection title="Troubleshooting">
        <LegalList>
          <li>
            <strong className="text-foreground">Sign-in or consent failed:</strong> Use the same
            Google account for PocketCircle. Retry from the assistant so a fresh approval window
            opens. If Google shows an extra verification step, complete it in the browser, then try
            again.
          </li>
          <li>
            <strong className="text-foreground">Assistant can&apos;t see Circles:</strong> Reconnect
            and select those Circles on the consent screen. Revoked or never-approved Circles stay
            inaccessible.
          </li>
          <li>
            <strong className="text-foreground">Access denied or tools stop working:</strong> Check
            Connections. Revoke the old client if needed, then connect again and re-approve Circles.
          </li>
          <li>
            <strong className="text-foreground">Cleanup pending after revoke:</strong> Access is
            already blocked. Use Retry on the connection card if PocketCircle still shows cleanup
            pending, or wait briefly and refresh Connections.
          </li>
          <li>
            <strong className="text-foreground">Expired or broken link:</strong> Start the
            connection again from the assistant or from Connections — don&apos;t reuse an old
            browser tab.
          </li>
          <li>
            <strong className="text-foreground">Old tools or package behavior:</strong> Refresh the
            connection or reinstall/update the PocketCircle package, then start a new assistant chat
            so the host reloads current MCP metadata and skills.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="Limits">
        <LegalList>
          <li>
            PocketCircle does not convert or sum different Currencies. Reporting stays per Currency.
          </li>
          <li>
            Assistants only use Circles and permissions you approve for that connection — not your
            whole account by default.
          </li>
          <li>
            PocketCircle does not add a country or region block beyond what the host&apos;s plugin
            directory allows.
          </li>
          <li>
            PocketCircle does not support Settlement, money transfers, or Currency conversion.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="Policies">
        <p>
          See the{" "}
          <Link
            to={href("/privacy")}
            className="font-medium text-primary underline underline-offset-4"
          >
            Privacy Policy
          </Link>{" "}
          and{" "}
          <Link
            to={href("/terms")}
            className="font-medium text-primary underline underline-offset-4"
          >
            Terms
          </Link>
          .
        </p>
      </LegalSection>
    </LegalDocument>
  );
}
