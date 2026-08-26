import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { NewCategoryForm } from "~/components/category-form.js";
import { Splash } from "~/components/splash.js";
import { circlePath } from "~/lib/circle-path.js";
import { parseReturnTo, RETURN_TO_PARAM } from "~/lib/return-to-url.js";
import { useSnackbar } from "~/lib/snackbar.js";
import { useCircle } from "~/routes/layouts/circle-layout.js";

/**
 * The new-Category route — `/circles/:circleRef/categories/new` (issue #96; revised #138;
 * Save & new #287). A dedicated create page so the Categories list no longer renders a
 * new-Category form above its rows alongside per-row edit forms and history panels — the
 * overload that issue removed. Same static-segment + lifecycle pattern as
 * `transaction-new.tsx`.
 *
 * Own param: `type=expense|income` is now an OPTIONAL initial default for the form's
 * in-form type toggle (issue #138), not a hard requirement. The list's All filter deep-links
 * no type (and you can't create an "all" category), and a filtered list deep-links its
 * concrete type. A missing / unrecognized `type` seeds `expense` — there's nothing to eject
 * over, since the toggle lets the user pick either type on the page.
 *
 * Close (cancel / ordinary Save) and the archived-Circle redirect land on `returnTo` —
 * the categories list the CTA was opened FROM, with its type/status/search intact, or the
 * bare list when absent / malformed / out-of-scope. Save & new stays on this URL, preserves
 * the validated origin, and the route owns the success snackbar + Name focus.
 */
export default function CategoryNew() {
  const circle = useCircle();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { show } = useSnackbar();
  const writable = circle.status === "active";

  const listBase = circlePath(circle.ref, "categories");
  const returnUrl = parseReturnTo(searchParams.get(RETURN_TO_PARAM), { fallback: listBase });

  // The toggle's starting type: a concrete deep-linked `type`, else `expense` (the list may
  // arrive with `type=all` or none under the default All view). The toggle owns it from here.
  const rawType = searchParams.get("type");
  const initialType = rawType === "income" ? "income" : "expense";

  const [closing, setClosing] = useState(false);
  const close = () => {
    setClosing(true);
    navigate(returnUrl);
  };

  const onSaveAndNewComplete = () => {
    show("Category added. Ready for another.");
    document.getElementById("category-name")?.focus();
  };

  // Only an archived (read-only) Circle ejects — the form can't write there. Replace so the
  // dead create URL leaves no Back entry. A missing/invalid `type` no longer ejects: the
  // in-form toggle defaults to `expense` and the user picks the type on the page (#138).
  useEffect(() => {
    if (!writable) {
      navigate(returnUrl, { replace: true });
    }
  }, [writable, navigate, returnUrl]);

  // This splash only ever shows while LEAVING — ejecting (archived) or closing (cancel /
  // save); a valid open renders the form immediately, never this. So the copy reflects the
  // return, not an open.
  if (!writable || closing) {
    return <Splash label="Returning…" />;
  }

  return (
    <NewCategoryForm
      circleId={circle.id}
      initialType={initialType}
      onClose={close}
      onSaveAndNewComplete={onSaveAndNewComplete}
    />
  );
}
