import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runViewgraph } from "../src/commands/viewgraph.js";
import { initStore } from "../src/core/store.js";
import { captureConsole } from "./helpers.js";

describe("runViewgraph", () => {
  let dir: string;
  let output: string[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "whyanchor-viewgraph-"));
    output = captureConsole();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = 0;
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses to start the graph server when no memory store exists", async () => {
    await runViewgraph(dir, { open: false });
    expect(process.exitCode).toBe(1);
  });

  it("rejects a --port that isn't a valid port number", async () => {
    await initStore(dir);
    for (const port of [Number.NaN, 0, 70000, 12.5]) {
      process.exitCode = 0;
      await runViewgraph(dir, { open: false, port });
      expect(process.exitCode).toBe(1);
    }
    expect(output.join("\n")).toMatch(/--port must be/);
  });

  it("refuses an explicit --port that is already taken instead of reporting someone else's server", async () => {
    // Regression: the readiness poll found whatever was already listening and printed "running".
    await initStore(dir);
    const blocker: Server = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      await runViewgraph(dir, { open: false, port });
      expect(process.exitCode).toBe(1);
      expect(output.join("\n")).toMatch(new RegExp(`Port ${port} is already in use`));
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
