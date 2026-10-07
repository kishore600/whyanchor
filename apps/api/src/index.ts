import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

// Render injects PORT (default 10000) and routes traffic to it; 3001 is the local default.
const port = Number(process.env.PORT ?? 3001);

const server = serve({ fetch: createApp().fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`whyanchor-api listening on :${info.port}`);
});

// Render sends SIGTERM on every deploy. Stop accepting connections, let in-flight requests
// finish, and bail out hard if that takes too long.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
