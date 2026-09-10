---
name: browse-authorized-records
description: Browse authorized PocketCircle Circles, Transactions, Categories, Members, histories, and reports; use when the user wants to inspect existing financial records through PocketCircle MCP.
---

# Browse authorized records

Use PocketCircle MCP tools to inspect data the User already authorized for this connection. Prefer refs from prior tool results over display names when names collide.

## Scope honesty

- This skill covers **reads**. The PocketCircle MCP server also exposes **write** tools (create/update/archive/restore Transactions and Categories). Do not claim the product or connection is read-only while those tools remain available.
- Access is limited to Circles approved on the consent screen for this connection. Newly created or joined Circles stay excluded until the User reauthorizes.
- Revoked connections and lost membership stop access. Distinguish an unavailable or revoked connection from an active read-only connection: reconnect only for the former. A read-only write denial means the current connection lacks `pocketcircle:write`; report that plainly and offer reauthorization with write access only if the User asks to change the connection.

## Workflow

1. Call `list_authorized_circles` (or `get_current_user` first if identity matters). Use each returned `circle.ref` in later tools — never invent refs.
2. For ambiguous Circle names, list authorized Circles and ask which `ref` to use, citing prior tool results.
3. Transactions: `search_transactions` then `get_transaction` / `list_transaction_history` as needed. Paginate until complete when totals or full coverage matter.
4. Categories: `list_categories`, `get_category`, `list_category_transactions`, `list_category_history`.
5. Members / Circle history: `list_members`, `list_circle_history`. Member `id` is Circle-specific; never substitute `get_current_user.id` into `paidByMemberIds`, `recordedByMemberIds`, or `paidByMemberId`.
6. Reports on an authorized Circle: `get_dashboard`, `get_monthly_ledger`, `get_monthly_comparison`, `get_category_analytics`. Keep Currencies separate — never sum across Currencies.

## Guardrails

- Do not send passwords, auth codes, tokens, or personal financial exports to support.
- Decline Settlement / money-transfer requests — PocketCircle does not support them.
- Empty results are valid; report them clearly instead of guessing.
