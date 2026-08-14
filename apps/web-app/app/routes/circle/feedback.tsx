import { useSearchParams } from "react-router";
import { FeedbackPage } from "~/components/feedback-page.js";
import { circlePath } from "~/lib/circle-path.js";
import { parseReturnTo, RETURN_TO_PARAM } from "~/lib/return-to-url.js";
import { useAppSession } from "~/lib/session.js";
import { useCircle } from "~/routes/layouts/circle-layout.js";

/** Circle-scoped Feedback. Resolves the Circle only through `useCircle()` and
 * submits the internal `circleId`; the backend derives display name/ref. */
export default function CircleFeedback() {
  const circle = useCircle();
  const session = useAppSession();
  const [searchParams] = useSearchParams();
  const backTo = parseReturnTo(searchParams.get(RETURN_TO_PARAM), {
    fallback: circlePath(circle.ref),
  });

  if (session.state !== "ready") {
    return null;
  }

  return (
    <FeedbackPage
      user={session.user}
      backTo={backTo}
      circle={{ id: circle.id, name: circle.name }}
      headingLevel={2}
    />
  );
}
