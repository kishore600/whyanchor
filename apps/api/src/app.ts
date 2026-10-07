import { Hono } from "hono";

export interface AppInfo {
  service: string;
  /** Short git sha of the running deploy, so a health check says which build answered. */
  commit: string;
}

function defaultInfo(): AppInfo {
  // Render sets RENDER_GIT_COMMIT for every deploy.
  return { service: "whyanchor-api", commit: (process.env.RENDER_GIT_COMMIT ?? "dev").slice(0, 7) };
}

export function createApp(info: AppInfo = defaultInfo()): Hono {
  const app = new Hono();

  // Render's health check and any uptime monitor hit this. Keep it free of I/O so a slow
  // dependency can never make Render restart an otherwise healthy service.
  app.get("/healthz", (c) => c.json({ status: "ok", ...info }));

  app.get("/", (c) => c.text("whyanchor api"));

  return app;
}
