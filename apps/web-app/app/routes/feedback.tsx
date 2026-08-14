import { useSearchParams } from "react-router";
import { FeedbackPage } from "~/components/feedback-page.js";
import { parseReturnTo, RETURN_TO_PARAM } from "~/lib/return-to-url.js";
import { useAppSession } from "~/lib/session.js";

/** Global Feedback — no Circle context. Circle-scoped `returnTo` is accepted as a
 * Back hint; anything else falls back to Home. */
export default function Feedback() {
  const session = useAppSession();
  const [searchParams] = useSearchParams();
  const backTo = parseReturnTo(searchParams.get(RETURN_TO_PARAM), { fallback: "/" });

  if (session.state !== "ready") {
    return null;
  }

  return <FeedbackPage user={session.user} backTo={backTo} />;
}
