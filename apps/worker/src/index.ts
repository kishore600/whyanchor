import { gitVersion } from "./git.js";

const HEARTBEAT_MS = 60_000;

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
}

async function main(): Promise<void> {
  let git: string;
  try {
    git = await gitVersion();
  } catch (err) {
    log({ level: "error", msg: "git is not available on PATH; the worker cannot run", error: String(err) });
    process.exit(1);
  }

  log({
    msg: "whyanchor-worker started",
    node: process.version,
    git,
    commit: (process.env.RENDER_GIT_COMMIT ?? "dev").slice(0, 7),
  });

  // Placeholder until the job queue lands: a Render background worker has to stay up, and a
  // heartbeat makes "is it alive" visible in the Render logs.
  const timer = setInterval(() => log({ msg: "heartbeat" }), HEARTBEAT_MS);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log({ msg: `${signal} received, shutting down` });
      clearInterval(timer);
      process.exit(0);
    });
  }
}

void main();
