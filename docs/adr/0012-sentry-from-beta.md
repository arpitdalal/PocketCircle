# Sentry with masked error replays from beta

PocketCircle uses Sentry from the start of beta for frontend error monitoring, release diagnostics, and error-triggered Session Replay. Replays use strict masking and blocking for sensitive UI content, normal session replay sampling stays off, and replay capture is used for operational debugging rather than product analytics.
