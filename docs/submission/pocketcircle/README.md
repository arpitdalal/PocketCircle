# PocketCircle submission candidate

Prepared for [#370](https://github.com/arpitdalal/PocketCircle/issues/370), 2026-09-09. Continue the maintainer's existing draft, originally imported from `~/Downloads/chatgpt-app-submission.json`. Do not create a duplicate submission. Do not submit, attest, or publish under this issue.

## Files and listing

- [Import JSON](chatgpt-app-submission.json): 25 tool annotations and justifications, exactly five positive cases, three required negative cases. The original Downloads file is unchanged.
- Ready-to-import local copy: `~/Downloads/chatgpt-app-submission-370.json`.
- [Production logo](../../../plugins/pocketcircle/assets/logo.png).
- Publisher: Arpit Dalal, individual. Contact: arpitdalalm@gmail.com.
- Name: PocketCircle. Subtitle: Track shared income & expenses. Category: Finance.
- Long description: use `app_info.description` in the import JSON.
- Website: https://pocketcircle.app
- Support: https://pocketcircle.app/support
- Privacy: https://pocketcircle.app/privacy
- Terms: https://pocketcircle.app/terms
- MCP: Universal URL `https://mcp.pocketcircle.app/mcp`, OAuth through existing Google sign-in and selected-Circle consent.
- No embedded UI. Do not invent widget CSP domains or workspace-domain restriction support.

Starter prompts:

1. Which PocketCircle Circles can I access, and what currency does each use?
2. Summarize my personal spending this month, honoring my Home Summary exclusions and keeping currencies separate.
3. Help me record an expense in PocketCircle. Ask me for the Circle, amount, date, Category and who paid.

Release notes:

> Initial PocketCircle plugin submission. Browse authorized Circles, Members, Transactions, Categories, histories and reports. Review personal spending using Paid By attribution, saved Home Summary exclusions and separate Currency totals. Create, update, archive and restore Transactions and Categories within connection and Member permissions, with previews by default and explicit handling of partial or uncertain outcomes. Includes three workflow skills. No Settlement, money transfer or Currency conversion.

The import JSON fills only part of the portal form. URLs, logo, identity, MCP/auth configuration, skills, starter prompts, countries and release notes must also be checked in the existing draft.

## Reviewer access and fixtures

The maintainer confirmed on 2026-09-09 that the checked host-test and reviewer-access requirements in #370 were completed manually. This record accepts that confirmation; it does not invent a new observed run or host build. [#364 evidence](https://github.com/arpitdalal/PocketCircle/issues/364#issuecomment-5574445974) records the Google-only arrangement, individual verification and cold-session test. [#365 evidence](https://github.com/arpitdalal/PocketCircle/issues/365#issuecomment-5575872671) records host screenshots.

Use only the dedicated synthetic reviewer account. The established fixture is `Pocket's Circle`, Personal, USD, active, reviewer Owner. Use its returned ref; the visible apostrophe may differ typographically. Never substitute the maintainer's personal account or a development-only connection.

Provide the demo username/password only through the portal's private reviewer-credential fields or the previously accepted secure handoff. Keep credentials, OAuth codes and tokens out of this directory and GitHub. The maintainer owns credential entry and any changes to Google account authentication.

Reviewer login:

1. Open https://pocketcircle.app/signin in a fresh browser session.
2. Choose Google and sign in with the privately supplied demo credentials.
3. Confirm the synthetic Home page loads.
4. Connect the production MCP URL in the reviewing host. On consent, select `Pocket's Circle` and enable read/write for positive cases.
5. Run P1 from the JSON. Confirm USD, active, reviewer Owner before writing.

Google 2SV/MFA is disabled for the accepted demo arrangement. Google may still challenge a new session. If it does, stop and contact the maintainer; do not enable production test-auth or claim challenge-free access is guaranteed.

### Reproducible cases and reset

Run positives in this order: P1, P2, P3, P4, P5. P2 creates the stable Category and Transaction used by later cases. Approve only the stated synthetic writes. Start N2 in a separate read-only connection. Restore the reviewer's normal connection afterward only by explicit reviewer action.

For N1, the reviewer account needs a second synthetic Circle named `PC370 Denied`, deliberately omitted from OAuth consent. Record its real ref from its PocketCircle web URL in the private reviewer notes. Confirm it is absent from P1. The name-only prompt verifies host behavior; the real-ref follow-up verifies server denial. Do not use a fabricated ref as proof of denied access. Provisioning and withholding this additional named fixture still need verification for this new case set.

Before rerunning P2, search all lifecycle states for the exact titles and names below. Record returned refs and inspect histories:

- Transaction `PC370 Review Lunch`, date `2026-08-15`, Note `Synthetic reviewer fixture`.
- Expense Category `PC370 Review` or `PC370 Review Updated`.
- N2 Category `PC370 Denied Write`, which must not exist after a successful denial case.

Never blindly repeat creates. Archive any prior active fixture Transaction after confirming its exact ref. Preserve historical records. If a previous Category holds either review name, restore it only with explicit lifecycle consent, rename it to a unique retired name such as `PC370 Retired <run-id>`, and archive it. Archived Category names still reserve uniqueness, so archiving alone is insufficient reset. Verify no active matching review Transaction and no Category in any state retaining either review name before P2. P2 then creates one active matching Category and Transaction; historical archived matches remain excluded from active searches and reporting.

If a write response is lost, inspect records and histories before deciding whether to retry. A matching record alone does not prove which call created it. Stop the sequence on failure, report completed operations, and preserve partial results for inspection. Do not delete audit history to reset tests.

## Portal and maintenance

1. Open the existing draft and record its URL/ID. Confirm verified Arpit Dalal identity and Apps Management write access.
2. Verify the Universal production URL and Google OAuth setup. Use the new JSON to update the draft's fields after reviewing import behavior.
3. The production MCP challenge endpoint returned HTTP 200 with a 43-character body on 2026-09-09. This does not establish that it matches this draft. Compare the portal's exact token without exposing it publicly. Do not overwrite another submission's token. The parent website returned HTML at the challenge path, which is not a valid challenge response.
4. Deploy the metadata correction before Scan Tools. Read tools persist connection usage and therefore advertise `readOnlyHint: false`. `create_transaction`, `restore_transaction` and `restore_category` can notify another Member and advertise `destructiveHint: true`. Compare all 25 tools against the JSON; retain real server schemas and structured output definitions.
5. Scan Tools, resolve actual validation errors, and inspect server instructions. Verify the three tested skills: `browse-authorized-records`, `spending-review`, `record-transactions`. If the server does not import them, use the portal's supported bundle upload with the existing [skill tree](../../../plugins/pocketcircle/skills/); do not treat an empty imported list as success.
6. Select every country/region the portal permits. Export or transcribe the actual selected names/codes and record any disabled options or limitation. PocketCircle imposes no residence restriction. Currency support does not restrict residence. Do not invent a country list from API availability documentation.
7. Save as draft. Leave policy attestations and submission to the maintainer, outside #370.

For later changes, update the existing [installation/refresh instructions](../../../plugins/pocketcircle/README.md), deploy applicable server changes, reinstall the local package, and retest affected workflows. Rescan tools and skills and inspect the new draft snapshot. Published skills are not live-linked to server edits. Relevant listing, metadata, skill and country changes require the supported version-review process. Keep reviewer fixtures usable throughout review, monitor support, and refresh public links and credentials through their secure channels.

Procedure source: [official OpenAI submission documentation](https://developers.openai.com/plugins/deploy/submission), checked 2026-09-09.

## #357 implementation acceptance

PASS below may rely on maintainer-confirmed manual completion. FAIL means remaining work or unverified evidence, not necessarily a product defect.

| Requirement | Result | Evidence or remaining work |
| --- | --- | --- |
| Feasibility and accepted Google reviewer arrangement | PASS | #364 and maintainer confirmation |
| Installation, update, connection, refresh, revocation, discovery and all operations in both hosts | PASS | #370 checked acceptance, maintainer confirmation |
| Reporting, Currency, exclusions, pagination, lifecycle, confirmation/override, malicious data, partial failure and uncertain creates | PASS | #366-#368 and #370 checked acceptance, maintainer confirmation |
| Existing reviewer access and fixture usability | PASS | Maintainer-confirmed completed checks |
| Public support, privacy, terms, website and logo | PASS | #369 closed; all four URLs HTTP 200 on 2026-09-09; existing package logo |
| Listing copy, prompts, release notes and maintenance instructions | PASS | This directory |
| Reproducible reviewer case definitions | PASS | Five positives, three required negatives in JSON; reset procedure above |
| New case fixture preparation | FAIL | Confirm reset state and withheld `PC370 Denied` real ref; run new cases against production reviewer connection |
| Individual publisher verification and submission permissions | PASS | #364 records verified individual and portal access; existing draft reported by maintainer |
| Final production metadata and portal Scan Tools | FAIL | Local metadata correction prepared; deployment and successful scan not observed |
| Exact draft domain verification | FAIL | Existing endpoint present; draft-token match not observed |
| Final skill snapshot | FAIL | Verify imported or uploaded three-skill tree in draft |
| Every permitted country selected and recorded | FAIL | Actual portal selections not yet inspected |
| Overall #357/#370 readiness | FAIL | Finish outstanding portal and new-case checks before closure |

No new submission, attestation, publication, or GitHub closure has been performed.

Validation on 2026-09-09: official submission JSON Schema passed; all 25 annotation entries match the corrected local server; 98 Worker tests passed; Worker typecheck, Biome checks and package validation passed. The environment used Node 25.2.1, outside the repository's declared engine range, and pnpm emitted an engine warning. Server changes remain local and are not evidence of a production deployment or portal scan.
