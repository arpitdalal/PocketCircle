import { Link } from "react-router";

/** Public confirmation that Account Deletion finished (USR-3). */
export default function DeleteAccountComplete() {
  return (
    <div className="space-y-4 rounded-xl border border-border bg-card/60 p-8 text-center shadow-xl backdrop-blur-sm">
      <h1 className="font-display text-2xl font-semibold tracking-tight">Account deleted</h1>
      <p className="text-sm text-muted-foreground">
        Your PocketCircle account has been permanently deleted. You&apos;re signed out.
      </p>
      <p className="text-sm">
        <Link to="/signin" className="font-medium text-primary underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
