import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConnect } from "../src/commands/connect.js";
import { npxServerCommand } from "../src/generators/agentConfig.js";
import { captureConsole, makeRepo } from "./helpers.js";

describe("runConnect", () => {
  let dir: string;
  let output: string[];
  const readJson = async (rel: string) => JSON.parse(await readFile(path.join(dir, rel), "utf8"));

  beforeEach(async () => {
    dir = await makeRepo("whyanchor-runconnect-");
    output = captureConsole();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = 0;
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps going when one agent's config can't be merged, then exits 1", async () => {
    // Regression: the error escaped as a stack trace and the remaining agents were never written.
    await mkdir(path.join(dir, ".cursor"));
    await writeFile(path.join(dir, ".cursor", "mcp.json"), "{ not json", "utf8");

    await runConnect(dir, { cliPath: "/abs/cli.js" });

    expect(process.exitCode).toBe(1);
    expect((await readJson(".mcp.json")).mcpServers.whyanchor).toEqual({ command: "node", args: ["/abs/cli.js", "mcp"] });
    expect(await readFile(path.join(dir, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.whyanchor]");
    expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toContain("<!-- whyanchor:usage:start -->");
    expect(await readFile(path.join(dir, ".cursor", "mcp.json"), "utf8")).toBe("{ not json");
    expect(output.join("\n")).toMatch(/✖ cursor .*not valid JSON/);
  });

  it("registers npx rather than a temporary npx-cache path", async () => {
    await runConnect(dir, {
      agent: "claude",
      noInstructions: true,
      cliPath: "/home/me/.npm/_npx/abc123/node_modules/whyanchor/dist/cli.js",
    });
    expect((await readJson(".mcp.json")).mcpServers.whyanchor).toEqual(npxServerCommand());
    expect(output.join("\n")).toMatch(/temporary package cache/);
  });

  it("honours a --command with a quoted path", async () => {
    await runConnect(dir, { agent: "claude", noInstructions: true, command: 'node "/opt/my tools/cli.js" mcp' });
    expect((await readJson(".mcp.json")).mcpServers.whyanchor).toEqual({ command: "node", args: ["/opt/my tools/cli.js", "mcp"] });
  });

  it("rejects an empty --command", async () => {
    await runConnect(dir, { agent: "claude", command: "  " });
    expect(process.exitCode).toBe(1);
  });

  it("reports everything unchanged on a second run", async () => {
    await runConnect(dir, { cliPath: "/abs/cli.js" });
    output.length = 0;
    await runConnect(dir, { cliPath: "/abs/cli.js" });
    const statusLines = output.filter((l) => l.startsWith("✔"));
    expect(statusLines).toHaveLength(5);
    expect(statusLines.every((l) => l.includes("unchanged"))).toBe(true);
  });

  it("refuses to run outside a git repo or before init", async () => {
    const noStore = await makeRepo("whyanchor-nostore-", { withStore: false });
    try {
      await runConnect(noStore, {});
      expect(process.exitCode).toBe(1);
      expect(output.join("\n")).toMatch(/No memory store found/);
    } finally {
      await rm(noStore, { recursive: true, force: true });
    }
  });
});
