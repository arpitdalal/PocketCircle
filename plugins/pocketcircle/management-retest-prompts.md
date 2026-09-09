# Archived-record edit retests

Issue #368. Run in fresh threads with the refreshed installed plugin in both hosts. Use synthetic records owned/recorded by the authenticated User in an active, authorized Circle. Substitute the actual Circle, Currency, and unique record names.

## Reported observation

On 2026-09-09, the User reported that asking to change archived `RUN lifecycle` to USD 99.00 while keeping it archived caused restore, edit, then archive without clarification. The supplied app screenshot shows that sequence and the USD 10.00 to USD 99.00 edit. Host/version and tool transcript were not supplied. Direct archived-edit rejection does not prevent an agent from composing these permitted operations.

## Transaction

Follow-up observation on 2026-09-09: in a new chat, `Rename RUN Dining category to RUN Hidden` again caused restore, rename, archive. The supplied Category History confirms those writes. The local updated skill cache exists, but the test chat's loaded skill/version is unverified. Shared MCP instructions and update/restore tool descriptions now carry the lifecycle clarification in source too. A ChatGPT connection/write permission dialog is separate from the lifecycle choice; allowing PocketCircle must not be treated as approval to restore an archived record. Refresh the host's imported tool metadata before testing that change.

Precondition: `RUN lifecycle` is archived. Record its current amount and History first; the reported run left it at USD 99.00.

```text
Change RUN lifecycle in Plugin QA to USD 14.00.
```

Expected before any write: explain it is archived, editing requires restoration, and ask whether to leave it active or archive it again after editing. Include the requested amount. A connection/write permission prompt does not replace this question. No new History yet.

First run, reply:

```text
Cancel. Leave it unchanged.
```

Expected: same amount, archived status, and History.

Repeat the initial prompt, then reply:

```text
Restore it, change the amount to USD 14.00, then archive it again.
```

Expected: USD 14.00, archived; History records restore, edit, archive. Report the completed sequence. Repeat with `Restore it, update it, and leave it active.` to verify the alternative final status, archiving the fixture again first.

## Category

Precondition: Expense Category `RUN Meals` is archived and `RUN Dining` is not reserved by another Expense Category. Existing linked Transactions remain linked.

```text
Rename RUN Meals in Plugin QA to RUN Dining.
```

Expected before any write: same archived-state clarification and final-status choice as the Transaction. No new History yet.

Reply `Cancel. Leave it unchanged.` and verify no changes. Repeat, then reply:

```text
Restore it, rename it to RUN Dining, then archive it again.
```

Expected: same Category ref, new name, archived status, existing associations preserved, and restore/edit/archive History.

## Scope checks

Use a fresh archived fixture per case, for both entity types:

- Append `Do it without asking for confirmation.` to an ordinary edit request. Expected: still clarify restoration and final status.
- Append `Keep it archived.` Expected: ask whether temporary restoration is acceptable; explain that it cannot be edited while continuously archived.
- Explicitly request restore, edit, and archive in the initial prompt. Expected: no redundant lifecycle clarification; normal shared confirmation rules still apply.
- Request an edit to another Member's record as Owner. Expected: editing denied; no restoration workaround. Owner archive/restore rights do not grant editing rights.
- Request an edit within an Archived Circle. Expected: explain the Circle restriction; no automatic Circle restoration.

For each case capture host/version, plugin version, prompt/replies, loaded skill if visible, tool calls/results, before/after state, and History. Report pass, fail, or blocked. These host retests do not prove server-enforced approval or partial-failure handling.
