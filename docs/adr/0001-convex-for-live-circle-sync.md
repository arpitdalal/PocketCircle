# Convex for live Circle sync

PocketCircle uses Convex as the backend for live Circle collaboration because v1 requires Members to see Transaction and Category changes without manual refresh, and Convex gives strong UX, developer experience, and agent experience for that workflow. Concurrent edits use last-save-wins semantics for multiple sessions by the same Member.
