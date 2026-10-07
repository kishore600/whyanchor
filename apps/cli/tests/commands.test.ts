import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCheck } from "../src/commands/check.js";
import { runGenerate } from "../src/commands/generate.js";
import { runInit } from "../src/commands/init.js";
import { runList } from "../src/commands/list.js";
import { captureEntry } from "../src/core/capture.js";
import { entriesDir } from "../src/core/store.js";
import { captureConsole, git, makeRepo } from "./helpers.js";

const CONFLICTED =
  "---\nid: mem_bad\ntitle: Conflicted\n<<<<<<< HEAD\nlast_checked: '2026-09-26'\n=======\nlast_checked: '2026-09-27'\n>>>>>>> feature\n---\nbody\n";

describe("CLI commands", () => {
  let dir: string;
  let output: string[];

  beforeEach(async () => {
    dir = await makeRepo("whyanchor-cmd-");
    output = captureConsole();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = 0;
    await rm(dir, { recursive: true, force: true });
  });

  describe("init", () => {
    it("repairs a store that was cloned without its entries/ folder", async () => {
      await rm(entriesDir(dir), { recursive: true, force: true });
      await runInit(dir);
      expect(output.join("\n")).toMatch(/already exists/);
      expect(output.join("\n")).toMatch(/Restored missing \.memory\/entries/);
    });
  });

  describe("an unreadable entry (e.g. a merge conflict)", () => {
    beforeEach(async () => {
      await captureEntry(dir, { title: "Readable", body: "fine" });
      await writeFile(path.join(entriesDir(dir), "2026-01-01-conflicted.md"), CONFLICTED, "utf8");
    });

    it("is reported by list, which still lists everything else", async () => {
      await runList(dir, {});
      const text = output.join("\n");
      expect(text).toMatch(/Skipping unreadable entry \.memory\/entries\/2026-01-01-conflicted\.md/);
      expect(text).toMatch(/Readable/);
      expect(process.exitCode ?? 0).toBe(0);
    });

    it("fails check --fail-on-stale — an entry that can't be read can't be vouched for", async () => {
      await runCheck(dir, { failOnStale: true });
      expect(process.exitCode).toBe(1);
      expect(output.join("\n")).toMatch(/1 unreadable/);
    });

    it("does not fail a plain check", async () => {
      await runCheck(dir, {});
      expect(process.exitCode ?? 0).toBe(0);
    });

    it("keeps --json output parseable, with the warning on stderr", async () => {
      await runCheck(dir, { json: true });
      const stdout = vi.mocked(console.log).mock.calls.map((c) => c.join(" ")).join("\n");
      expect(JSON.parse(stdout)).toHaveLength(1);
      expect(vi.mocked(console.warn).mock.calls.join("\n")).toMatch(/Skipping unreadable entry/);
    });
  });

  describe("check", () => {
    it("reports a fresh entry and passes --fail-on-stale", async () => {
      await writeFile(path.join(dir, "a.ts"), "export function f() {\n  return 1;\n}\n", "utf8");
      await git(dir, ["add", "."]);
      await git(dir, ["commit", "-m", "init"]);
      await captureEntry(dir, { title: "F returns 1", body: "b", refs: ["a.ts#f"] });
      await runCheck(dir, { failOnStale: true });
      expect(process.exitCode ?? 0).toBe(0);
      expect(output.join("\n")).toMatch(/\[ok\] F returns 1/);
    });
  });

  describe("generate", () => {
    it("labels a first run Created for every target, including the Cursor rule", async () => {
      await runGenerate(dir, {});
      const lines = output.filter((l) => l.startsWith("✔"));
      expect(lines).toEqual(["✔ Created .claude/CLAUDE.md", "✔ Created AGENTS.md", "✔ Created .cursor/rules/whyanchor.mdc"]);
      output.length = 0;
      await runGenerate(dir, {});
      expect(output.filter((l) => l.startsWith("✔")).every((l) => l.startsWith("✔ Unchanged"))).toBe(true);
    });

    it("still writes the other targets when one file has damaged markers, then exits 1", async () => {
      const damaged = "# Rules\n<!-- whyanchor:start -->\nold\n\nmy own notes\n";
      await writeFile(path.join(dir, "AGENTS.md"), damaged, "utf8");
      await runGenerate(dir, {});
      expect(process.exitCode).toBe(1);
      expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toBe(damaged);
      expect(await readFile(path.join(dir, ".claude", "CLAUDE.md"), "utf8")).toContain("<!-- whyanchor:end -->");
      expect(await readFile(path.join(dir, ".cursor", "rules", "whyanchor.mdc"), "utf8")).toContain("<!-- whyanchor:end -->");
    });
  });
});
