# Google reviewer authentication for issue #357

Researched 2026-09-06 for [#357](https://github.com/arpitdalal/PocketCircle/issues/357). Official Google sources only. No live sign-in or production configuration inspection performed.

**Google-only authentication cannot be promised to give an unfamiliar reviewer a challenge-free login.** Google explicitly allows additional verification even when 2-Step Verification is off. This is a public-submission feasibility question to resolve before full plugin implementation, not an assumption to defer until submission. [Google prompts](https://support.google.com/accounts/answer/7026266?hl=en)

## What Google establishes

- Consumer accounts can receive phone prompts without enabling passwordless phone login or 2-Step Verification. A different location can trigger additional verification. [Google prompts](https://support.google.com/accounts/answer/7026266?hl=en)
- Google sometimes requires phone verification before account creation **or sign-in** to prevent abuse. Creating a separate demo account does not establish a permanent exemption. [Verify your account](https://support.google.com/accounts/answer/114129?hl=en)
- Workspace also uses risk-based challenges when 2SV is off. Unusual sign-in patterns and locations can trigger them; Google chooses the challenge. Admins can disable a challenge for one user for ten minutes, not permanently for the organization. An asynchronous review cannot reliably depend on that window. [Workspace security challenges](https://knowledge.workspace.google.com/admin/security/protect-google-workspace-accounts-with-security-challenges)
- OAuth test users control authorization eligibility, not Google account login challenges. Google documents a 100-user Testing limit and seven-day authorizations, with an exception for basic name/email/profile scopes and Sign in with Google. No account-challenge exemption is documented there. External production apps can accept Google accounts, subject to account restrictions and applicable verification. [Manage app audience](https://support.google.com/cloud/answer/15549945)
- Google requires secure browser authorization, forbids developer-controlled embedded user agents, and requires compliant HTTPS redirects. Production branding and scope verification requirements also apply. These are integration checks; satisfying them does not remove account verification challenges. [OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies)

## PocketCircle baseline

[`auth.ts`](../../packages/convex/convex/auth.ts) configures Google with `prompt: "select_account"`. Email/password exists only behind `E2E_TEST_AUTH`, explicitly limited to ephemeral test deployments. Enabling it in production would change the current authentication design and is outside the user's approved scope.

Google Cloud's actual publishing status, approved branding, credentials, scopes observed in a live request, and reviewer-account settings were not inspected. Source code alone cannot establish those deployment facts.

## What can be proved before building

| Question | Evidence needed | Limit |
| --- | --- | --- |
| Does the existing Google redirect work from each intended host? | Small live connection experiment using current MCP/auth, logged-out browser, and a harmless read | Proves that account, host, deployment, and moment |
| Can a separate reviewer account connect without owner assistance? | Separate-account experiment through the same production path | Does not guarantee a later login from another location |
| Will public review accept this Google-only access arrangement? | Written clarification from the reviewing platform, or an accepted review | Google documentation cannot answer the platform's acceptance decision |

Recommendation: gate full plugin implementation on the small live experiment and a documented acceptable reviewer-access arrangement. Keep production Google-only. If the reviewing platform insists on supplied credentials guaranteed to work without any challenge or owner assistance, the Google sources above do not establish a compliant guaranteed path. Stop at that unresolved feasibility gate rather than claiming certainty or expanding production authentication.

A successful connection test is useful and necessary. It cannot turn Google's risk-based behavior into a 100% guarantee.

## Accepted gate and draft inquiry

The maintainer accepted successful real Google-to-MCP testing in ChatGPT and Codex plus written OpenAI guidance accepting the reviewer-access arrangement as the gate before plugin implementation. Neither requirement is complete.

Draft for the maintainer to send to OpenAI developer support. Not sent:

> We plan to submit PocketCircle, an authenticated MCP-backed plugin for ChatGPT and Codex. PocketCircle uses Google-only sign-in for its web consent flow and issues separate PocketCircle MCP tokens. We can prepare a dedicated Google test account and seeded synthetic Circle data. Google may impose risk-based verification on an unfamiliar reviewer login even when two-step verification is disabled. Your submission requirements say reviewer credentials must work without MFA, SMS, or email confirmation. Is this Google-only arrangement acceptable, and what supported review process should we use if Google challenges the supplied account? We are not adding an alternative production authentication method or enabling a test-auth bypass. Please confirm an acceptable reviewer-access arrangement before we package the plugin.
