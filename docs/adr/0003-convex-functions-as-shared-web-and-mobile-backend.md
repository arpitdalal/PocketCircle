# Convex functions as shared web and mobile backend

PocketCircle v1 ships as a responsive web app, with Convex functions in `packages/convex` as the shared backend contract rather than a custom REST API or custom WebSocket server. This keeps live Circle updates simple for v1 while preserving a future mobile app path through the same Convex backend; HTTP endpoints should be added only for integrations, webhooks, or public API needs.
