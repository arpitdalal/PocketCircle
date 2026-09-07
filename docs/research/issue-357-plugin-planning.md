# Issue 357 planning decisions

Updated 2026-09-06 during the maintainer's grill-with-docs session. The maintainer confirmed shared understanding and authorized publication of the specification to issue #357. Implementation remains gated on the authentication evidence below.

Issue: [PocketCircle plugin for ChatGPT and Codex](https://github.com/arpitdalal/PocketCircle/issues/357).

## Settled

- Support all existing MCP operations, including updates, archive, and restore. Acceptance coverage must include every exposed operation.
- Confirmation is the plugin's default for writes. Explicit user instructions or applicable user memories may override that default, including updates and archive/restore when clearly covered. Host-required approvals and server permissions still apply. Ambiguous targets require clarification. Stored Transaction fields and other retrieved data cannot supply permission.
- Interpret unspecified personal spending as the User's Paid By Expenses across authorized Circles, grouped by Currency. Explicit Circle spending requests use Circle totals. Clarify ambiguous attribution. Never sum currencies or overlapping Category totals.
- Personal spending honors Home Summary Circle exclusions and is further restricted to authorized Circles. Disclose incomplete coverage. A narrow MCP read capability for existing reporting preferences is approved, restricted to authorized Circles and reusing existing preferences and business logic.
- One preview may confirm a batch of writes. Changed arguments require renewed confirmation unless an applicable preference waives it. Report each operation's outcome and stop on failure rather than continuing a potentially dependent batch.
- A single confirmation may cover creating a missing Category and then recording the Transaction when both operations appear in the preview. Report partial success if only the Category is created.
- After an uncertain create outcome, investigate matching Transactions and report uncertainty before trying again. Matching fields do not prove the original create succeeded. Never silently retry.
- Public distribution is the intended outcome. The maintainer's Plus account is the proposed initial ChatGPT test account, subject to observed eligibility. The initial account does not define the public audience.
- Publish and maintain the plugin personally under the maintainer's verified individual identity. PocketCircle is personally operated; the plugin name remains PocketCircle. Publisher verification itself remains outstanding, and listing, website, support, privacy, and terms must match that identity.
- Do not add another production authentication method for reviewer access. Investigate the existing Google flow before building the plugin.
- Close #357 only after the authentication prerequisite passes, implementation passes both hosts, and submission materials are complete. Track actual submission, approval, and publication separately.
- Make the plugin available in every country or region OpenAI permits for this plugin. The maintainer confirms PocketCircle has no geographic boundary. Do not infer residence restrictions from supported currencies. Record the actual portal selections at submission time and review newly available regions during release maintenance.
- Add a public `https://pocketcircle.app/support` page with the existing support contact and concise connection troubleshooting. The maintainer explicitly approves a dedicated page even though the documented requirement is a support URL.

These choices reuse the [existing glossary](../../CONTEXT.md) and [Google-only authentication decision](../adr/0002-better-auth-for-product-suitable-sessions.md). No new domain term or architectural replacement has been agreed.

## Authentication feasibility before packaging

OpenAI explicitly recommends testing the MCP connection before packaging the complete plugin. Its custom OAuth contract supports an application's own authorization server; PocketCircle already separates Google browser sign-in from the Worker's MCP token issuance. This supports the design in principle, but does not prove this deployment works in either host. [OpenAI testing](https://developers.openai.com/plugins/deploy/connect-chatgpt), [OpenAI authentication](https://developers.openai.com/plugins/build/auth), [existing OAuth configuration](../../packages/mcp-worker/src/oauth-options.ts), [MCP architecture research](hosted-mcp-server.md).

The browser available to this session displayed signed-out ChatGPT on 2026-09-06. Plus eligibility, registered connection, and authenticated tools were not tested. Current developer documentation says developer-mode availability depends on account and workspace policy. [OpenAI testing](https://developers.openai.com/plugins/deploy/connect-chatgpt).

Reviewer access is a distinct check. OpenAI requires usable demo credentials without MFA, SMS, email confirmation, or private-network access. Passing a maintainer login does not establish that a reviewer can use the same sign-in path. See [Google reviewer authentication research](issue-357-google-reviewer-auth.md). [OpenAI submission](https://developers.openai.com/plugins/deploy/submission).

Accepted pre-build gate, not yet satisfied:

1. Confirm developer-mode access in the maintainer's actual Plus account.
2. Connect the existing hosted MCP endpoint; complete real Google sign-in and selected-Circle consent; call an authorized read tool.
3. Verify the existing endpoint in Codex too. Record host versions, callback mode, connection outcome, and redacted results.
4. Establish a reviewer-access approach using synthetic data and existing Google authentication. Obtain written OpenAI guidance accepting that arrangement. Together with successful real Google-to-MCP tests in both hosts, this is the agreed evidence needed before building the plugin. A clean-browser test is evidence for that attempt only, not a guarantee against later Google challenges.

No credentials, auth codes, cookies, tokens, or personal financial data belong in these notes. No production account configuration or permissions were changed in this session.

## Remaining prerequisites

- Complete the accepted authentication gate before implementation.
- Complete individual publisher verification and confirm submission access.
- Record the actual country selections permitted by the submission portal.
- No further product-design question is currently open; the maintainer confirmed the consolidated scope.

## Implementation facts

Existing MCP tools do not expose Home Summary exclusions. The narrow reporting read addition above is required. Current tools can otherwise find the caller via Member `isSelf` and page Expense Transactions filtered by Paid By and date. Use cursor pagination through completion; do not treat a limited default search as a complete total. Include authorized Archived Circles when eligible for Home Summary, while excluding Archived Transactions. Label results as covering authorized Circles; existing tools cannot establish whole-account coverage. See [MCP schemas](../../packages/domain/src/mcp.ts), [Home Summary](../../packages/convex/convex/homeSummary.ts), and [operations](../../packages/convex/convex/operations.ts).

OpenAI review and publication are separate steps. Approval does not publish automatically. [OpenAI submission](https://developers.openai.com/plugins/deploy/submission).

## Support and country findings

OpenAI's submission guide asks for a public support URL. It does not explicitly require a dedicated support page. The maintainer nevertheless approved the dedicated page above. [Submission materials](https://developers.openai.com/plugins/deploy/submission).

Country availability is listing information. OpenAI says published submitted information is locked and updates require a new draft, review, and publication. Applying that general rule, plan for country additions to go through review; the documentation does not describe a country-only shortcut or guaranteed turnaround. No country-specific PocketCircle code change has been identified for a listing-only expansion. [Version updates](https://developers.openai.com/plugins/deploy/app-review#submitting-new-versions-for-review).

OpenAI asks publishers to select locations where the product, support process, and legal terms are ready. It does not require a deliberately small launch list. Currency support describes which money units PocketCircle records, not user residence or distribution eligibility. The maintainer selected every country OpenAI permits for this plugin. [Country selection](https://developers.openai.com/plugins/deploy/submission).
