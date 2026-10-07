import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("prompts", () => ({ default: vi.fn(async () => ({})) }));

import prompts from "prompts";
import { runCapture } from "../src/commands/capture.js";
import { CaptureError, captureEntry } from "../src/core/capture.js";
import { entriesDir, listEntries } from "../src/core/store.js";
import { captureConsole, makeRepo } from "./helpers.js";

describe("captureEntry", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeRepo("whyanchor-capture-");
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "billing.ts"), "export function calculateTax(a: number) {\n  return a * 0.2;\n}\n", "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("normalizes and de-duplicates refs and tags, fingerprinting each ref", async () => {
    const result = await captureEntry(dir, {
      title: "Tax",
      body: "why",
      refs: ["./src\\billing.ts#calculateTax", path.join(dir, "src", "billing.ts"), "src/billing.ts"],
      tags: [" billing ", "billing"],
    });
    const f = result.entry.frontmatter;
    expect(f.refs).toEqual(["src/billing.ts#calculateTax", "src/billing.ts"]);
    expect(f.tags).toEqual(["billing"]);
    expect(f.fingerprint["src/billing.ts#calculateTax"].kind).toBe("symbol");
    expect(f.fingerprint["src/billing.ts"].kind).toBe("file");
    expect(f.author).toBe("dev@example.com");
  });

  it("reports unresolved refs, whole-file fallbacks and refs outside the repo", async () => {
    const result = await captureEntry(dir, { title: "T", body: "b", refs: ["src/nope.ts", "src/billing.ts#noSuch", "../elsewhere.ts"] });
    expect(result.unresolvedRefs).toEqual(["src/nope.ts", "../elsewhere.ts"]);
    expect(result.wholeFileRefs).toEqual(["src/billing.ts#noSuch"]);
    expect(result.outsideRepoRefs).toEqual(["../elsewhere.ts"]);
    // The fallback is stored as a checkable whole-file fingerprint, not an uncheckable "missing" one.
    expect(result.entry.frontmatter.fingerprint["src/billing.ts#noSuch"].kind).toBe("file");
  });

  it("does not throw on a symbol containing regex metacharacters", async () => {
    const result = await captureEntry(dir, { title: "T", body: "b", refs: ["src/billing.ts#git("] });
    expect(result.wholeFileRefs).toEqual(["src/billing.ts#git("]);
  });

  it("supersedes an entry, and reports when it had already been superseded", async () => {
    const first = await captureEntry(dir, { title: "v1", body: "b" });
    const second = await captureEntry(dir, { title: "v2", body: "b", supersedes: first.entry.frontmatter.id });
    expect(second.entry.frontmatter.supersedes).toBe(first.entry.frontmatter.id);
    expect(second.superseded?.frontmatter.status).toBe("superseded");
    expect(second.alreadySupersededBy).toEqual([]);

    const third = await captureEntry(dir, { title: "v2b", body: "b", supersedes: first.entry.frontmatter.id });
    expect(third.alreadySupersededBy).toEqual([second.entry.frontmatter.id]);
  });

  it("refuses an unknown supersedes id and an empty title or body, writing nothing", async () => {
    await expect(captureEntry(dir, { title: "x", body: "y", supersedes: "mem_nope" })).rejects.toThrow(CaptureError);
    await expect(captureEntry(dir, { title: "  ", body: "y" })).rejects.toThrow(CaptureError);
    await expect(captureEntry(dir, { title: "x", body: "\n" })).rejects.toThrow(CaptureError);
    expect(await listEntries(dir)).toEqual([]);
  });

  it("keeps the title on one line", async () => {
    const result = await captureEntry(dir, { title: "Line one\n  line two", body: "b" });
    expect(result.entry.frontmatter.title).toBe("Line one line two");
  });
});

describe("runCapture", () => {
  let dir: string;
  let output: string[];

  beforeEach(async () => {
    dir = await makeRepo("whyanchor-runcapture-");
    output = captureConsole();
    vi.mocked(prompts).mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = 0;
    await rm(dir, { recursive: true, force: true });
  });

  it("captures in a fresh clone whose empty entries/ folder git didn't keep", async () => {
    await rm(entriesDir(dir), { recursive: true, force: true });
    await runCapture(dir, { title: "First note", message: "after clone" });
    expect(process.exitCode ?? 0).toBe(0);
    expect(await listEntries(dir)).toHaveLength(1);
  });

  it("rejects an unknown --supersedes id before asking any questions", async () => {
    await runCapture(dir, { supersedes: "mem_nope" });
    expect(prompts).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(output.join("\n")).toMatch(/No memory entry found with id "mem_nope"/);
    expect(await listEntries(dir)).toEqual([]);
  });

  it("prints a repo-relative path and warns about a whole-file fallback", async () => {
    await writeFile(path.join(dir, "a.ts"), "const x = 1;\n", "utf8");
    await runCapture(dir, { title: "Note", message: "m", refs: ["a.ts#missingFn"] });
    const text = output.join("\n");
    expect(text).toMatch(/→ \.memory\/entries\/\d{4}-\d{2}-\d{2}-note-mem_/);
    expect(text).toMatch(/watching the whole file instead: a\.ts#missingFn/);
  });

  it("warns when the superseded entry already had a replacement", async () => {
    const first = await captureEntry(dir, { title: "v1", body: "b" });
    await captureEntry(dir, { title: "v2", body: "b", supersedes: first.entry.frontmatter.id });
    await runCapture(dir, { title: "v3", message: "m", supersedes: first.entry.frontmatter.id });
    expect(output.join("\n")).toMatch(/had already been superseded by/);
  });
});
