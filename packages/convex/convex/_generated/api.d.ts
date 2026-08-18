/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accountDeletion from "../accountDeletion.js";
import type * as accountDeletionAuth from "../accountDeletionAuth.js";
import type * as accountDeletionBlockers from "../accountDeletionBlockers.js";
import type * as accountDeletionFinalize from "../accountDeletionFinalize.js";
import type * as activation from "../activation.js";
import type * as asyncBatch from "../asyncBatch.js";
import type * as auth from "../auth.js";
import type * as categories from "../categories.js";
import type * as circleSetup from "../circleSetup.js";
import type * as circles from "../circles.js";
import type * as dashboard from "../dashboard.js";
import type * as e2e from "../e2e.js";
import type * as e2eTesting from "../e2eTesting.js";
import type * as email from "../email.js";
import type * as export_ from "../export.js";
import type * as feedback from "../feedback.js";
import type * as guard from "../guard.js";
import type * as history from "../history.js";
import type * as historyView from "../historyView.js";
import type * as homeSummary from "../homeSummary.js";
import type * as http from "../http.js";
import type * as invitationToken from "../invitationToken.js";
import type * as invitations from "../invitations.js";
import type * as ledger from "../ledger.js";
import type * as memberIdentity from "../memberIdentity.js";
import type * as members from "../members.js";
import type * as model from "../model.js";
import type * as monthActivity from "../monthActivity.js";
import type * as notifications from "../notifications.js";
import type * as notify from "../notify.js";
import type * as search from "../search.js";
import type * as terminalFailure from "../terminalFailure.js";
import type * as terminalFailureSentry from "../terminalFailureSentry.js";
import type * as transactionSearchDocuments from "../transactionSearchDocuments.js";
import type * as transactions from "../transactions.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accountDeletion: typeof accountDeletion;
  accountDeletionAuth: typeof accountDeletionAuth;
  accountDeletionBlockers: typeof accountDeletionBlockers;
  accountDeletionFinalize: typeof accountDeletionFinalize;
  activation: typeof activation;
  asyncBatch: typeof asyncBatch;
  auth: typeof auth;
  categories: typeof categories;
  circleSetup: typeof circleSetup;
  circles: typeof circles;
  dashboard: typeof dashboard;
  e2e: typeof e2e;
  e2eTesting: typeof e2eTesting;
  email: typeof email;
  export: typeof export_;
  feedback: typeof feedback;
  guard: typeof guard;
  history: typeof history;
  historyView: typeof historyView;
  homeSummary: typeof homeSummary;
  http: typeof http;
  invitationToken: typeof invitationToken;
  invitations: typeof invitations;
  ledger: typeof ledger;
  memberIdentity: typeof memberIdentity;
  members: typeof members;
  model: typeof model;
  monthActivity: typeof monthActivity;
  notifications: typeof notifications;
  notify: typeof notify;
  search: typeof search;
  terminalFailure: typeof terminalFailure;
  terminalFailureSentry: typeof terminalFailureSentry;
  transactionSearchDocuments: typeof transactionSearchDocuments;
  transactions: typeof transactions;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
  emailWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"emailWorkpool">;
};
