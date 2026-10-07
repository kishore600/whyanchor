import { type ChildProcess, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRepoRoot } from "../core/git.js";
import { openInBrowser } from "../core/open.js";
import { storeExists } from "../core/store.js";

const require = createRequire(import.meta.url);

export interface ViewgraphOptions {
  tag?: string;
  port?: number;
  open?: boolean;
}

const DEFAULT_PORT = 4317;
const READY_TIMEOUT_MS = 20_000;
// Loopback only: the graph exposes every captured decision, and `next start` would otherwise listen
// on all interfaces — reachable by anyone on the same Wi-Fi or office network.
const HOST = "127.0.0.1";

/** dist/commands/viewgraph.js -> the package root, two levels up. */
function packageRoot(): string {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, HOST, () => probe.close(() => resolve(true)));
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Polls until the server answers — or the child exits first. Without the exit check, a server that
 * failed to start (e.g. port taken) looks "ready" whenever something else answers on that port.
 */
async function waitUntilReady(url: string, timeoutMs: number, exited: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !exited()) {
    try {
      const res = await fetch(url);
      if (res.status < 500 && !exited()) return true;
    } catch {
      // Server isn't accepting connections yet — keep polling.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function stopOnSignal(child: ChildProcess): void {
  const stop = () => child.kill();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

export async function runViewgraph(cwd: string, opts: ViewgraphOptions): Promise<void> {
  const repoRoot = (await getRepoRoot(cwd)) ?? cwd;

  if (!(await storeExists(repoRoot))) {
    console.error("✖ No memory store found. Run `whyanchor init` first.");
    process.exitCode = 1;
    return;
  }

  if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)) {
    console.error("✖ --port must be a whole number between 1 and 65535.");
    process.exitCode = 1;
    return;
  }

  let port: number;
  if (opts.port !== undefined) {
    if (!(await isPortFree(opts.port))) {
      console.error(`✖ Port ${opts.port} is already in use. Pick another with --port, or omit it to use a free one.`);
      process.exitCode = 1;
      return;
    }
    port = opts.port;
  } else {
    port = (await isPortFree(DEFAULT_PORT)) ? DEFAULT_PORT : await getFreePort();
  }

  const appDir = path.join(packageRoot(), "graph-app");
  try {
    await access(path.join(appDir, ".next", "BUILD_ID"));
  } catch {
    console.error(`✖ The graph app hasn't been built (${path.join(appDir, ".next")} is missing). From a source checkout, run \`npm run build\` first.`);
    process.exitCode = 1;
    return;
  }

  const nextBin = require.resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [nextBin, "start", appDir, "-p", String(port), "-H", HOST], {
    env: { ...process.env, WHYANCHOR_REPO_ROOT: repoRoot },
    stdio: "inherit",
  });
  // Track exit from the moment of spawning: a listener attached later would miss an early exit and
  // leave the CLI waiting forever on a child that is already gone.
  let exitCode: number | null | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code) => {
      exitCode = code;
      resolve();
    });
  });
  stopOnSignal(child);

  const urlPath = opts.tag ? `/?tag=${encodeURIComponent(opts.tag)}` : "/";
  const url = `http://${HOST}:${port}${urlPath}`;

  console.log(`Starting the knowledge graph server…`);
  const ready = await waitUntilReady(`http://${HOST}:${port}/api/graph`, READY_TIMEOUT_MS, () => exitCode !== undefined);

  if (ready) {
    console.log(`✔ Knowledge graph running at ${url}`);
    console.log("Press Ctrl+C to stop.");
    if (opts.open !== false) {
      const opened = await openInBrowser(url);
      if (!opened) console.log(`Open it yourself: ${url}`);
    }
  } else if (exitCode !== undefined) {
    console.error(`✖ The graph server exited before it was ready (exit code ${exitCode}) — see the output above.`);
    process.exitCode = 1;
    return;
  } else {
    console.warn(`⚠ The server did not respond within ${READY_TIMEOUT_MS / 1000}s — check the output above for errors.`);
  }

  await exited;
}
