import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  entriesDir,
  entryFileName,
  findEntryById,
  initStore,
  listEntries,
  loadEntries,
  localDate,
  readEntryFile,
  updateEntryFrontmatter,
  writeEntry,
} from "../src/core/store.js";

const BASE = {
  author: "a",
  tags: [],
  refs: [],
  supersedes: null,
  status: "active" as const,
  commit: null,
  fingerprint: {},
  last_checked: null,
};

describe("memory store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "whyanchor-store-"));
    await initStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips an entry through write and read", async () => {
    const written = await writeEntry(
      dir,
      {
        title: "Chose Postgres over Mongo",
        author: "kishore.k@dataflo.ai",
        tags: ["architecture", "billing"],
        refs: ["src/billing.ts#calculateTax"],
        supersedes: null,
        status: "active",
        commit: "abc123",
        fingerprint: { "src/billing.ts#calculateTax": { hash: "deadbeef", kind: "symbol" } },
        last_checked: null,
      },
      "We needed multi-document transactions for tax reconciliation."
    );

    const read = await readEntryFile(written.filePath);
    expect(read.frontmatter.title).toBe("Chose Postgres over Mongo");
    expect(read.frontmatter.tags).toEqual(["architecture", "billing"]);
    expect(read.frontmatter.refs).toEqual(["src/billing.ts#calculateTax"]);
    expect(read.frontmatter.fingerprint["src/billing.ts#calculateTax"].hash).toBe("deadbeef");
    expect(read.body).toContain("multi-document transactions");
  });

  it("lists entries newest-first and finds by id", async () => {
    const first = await writeEntry(
      dir,
      {
        title: "First",
        author: "a",
        tags: [],
        refs: [],
        supersedes: null,
        status: "active",
        commit: null,
        fingerprint: {},
        last_checked: null,
        date: "2026-01-01",
      },
      "first body"
    );
    const second = await writeEntry(
      dir,
      {
        title: "Second",
        author: "a",
        tags: [],
        refs: [],
        supersedes: null,
        status: "active",
        commit: null,
        fingerprint: {},
        last_checked: null,
        date: "2026-06-01",
      },
      "second body"
    );

    const entries = await listEntries(dir);
    expect(entries.map((e) => e.frontmatter.id)).toEqual([second.frontmatter.id, first.frontmatter.id]);

    const found = await findEntryById(dir, first.frontmatter.id);
    expect(found?.frontmatter.title).toBe("First");
  });

  it("updates frontmatter in place, preserving the body", async () => {
    const entry = await writeEntry(
      dir,
      {
        title: "Mutable",
        author: "a",
        tags: [],
        refs: [],
        supersedes: null,
        status: "active",
        commit: null,
        fingerprint: {},
        last_checked: null,
      },
      "body text"
    );

    const updated = await updateEntryFrontmatter(entry, { status: "superseded" });
    expect(updated.frontmatter.status).toBe("superseded");

    const reread = await readEntryFile(entry.filePath);
    expect(reread.frontmatter.status).toBe("superseded");
    expect(reread.body).toBe("body text");
  });

  it("reads an entry hand-written exactly in the README's documented format", async () => {
    // Regression: YAML parses the unquoted `date: 2026-09-21` as a Date, which failed validation
    // and crashed every command.
    await writeFile(
      path.join(entriesDir(dir), "2026-09-21-readme-example.md"),
      [
        "---",
        "id: mem_a8AwCAoR",
        "title: Enterprise discount is 30% by contract, not a guess",
        "date: 2026-09-21",
        "author: you@example.com",
        "tags: [pricing, legal]",
        "refs: [src/pricing.ts#calculateDiscount]",
        "supersedes: null",
        "status: active",
        "commit: 8f3a1c2",
        "fingerprint:",
        "  src/pricing.ts#calculateDiscount: { hash: 7ac9f1e2b3d4c5a6, kind: symbol }",
        "last_checked: 2026-09-22T10:00:00.000Z",
        "---",
        "",
        "Legal signed off on 30% in the 2026 MSA template.",
      ].join("\n"),
      "utf8"
    );
    const [entry] = await listEntries(dir);
    expect(entry.frontmatter.date).toBe("2026-09-21");
    expect(entry.frontmatter.last_checked).toBe("2026-09-22T10:00:00.000Z");
    expect(entry.frontmatter.tags).toEqual(["pricing", "legal"]);
    expect(entry.frontmatter.fingerprint["src/pricing.ts#calculateDiscount"]).toEqual({ hash: "7ac9f1e2b3d4c5a6", kind: "symbol" });
  });

  it("accepts other hand-written YAML scalars: a numeric commit or hash, a single tag string", async () => {
    await writeFile(
      path.join(entriesDir(dir), "x.md"),
      "---\nid: mem_x\ntitle: T\ndate: '2026-01-01'\nauthor: a\ntags: pricing\ncommit: 1234567\nfingerprint:\n  a.ts: { hash: 1234567890, kind: file }\n---\nbody\n",
      "utf8"
    );
    const [entry] = await listEntries(dir);
    expect(entry.frontmatter.tags).toEqual(["pricing"]);
    expect(entry.frontmatter.commit).toBe("1234567");
    expect(entry.frontmatter.fingerprint["a.ts"].hash).toBe("1234567890");
  });

  it("isolates an unreadable entry instead of failing the whole store", async () => {
    const good = await writeEntry(dir, { ...BASE, title: "Good" }, "fine");
    const bad = path.join(entriesDir(dir), "2026-01-01-conflicted.md");
    await writeFile(
      bad,
      "---\nid: mem_bad\ntitle: Conflicted\n<<<<<<< HEAD\nlast_checked: '2026-09-26'\n=======\nlast_checked: '2026-09-27'\n>>>>>>> feature\n---\nbody\n",
      "utf8"
    );

    const { entries, invalid } = await loadEntries(dir);
    expect(entries.map((e) => e.frontmatter.id)).toEqual([good.frontmatter.id]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].filePath).toBe(bad);
    expect(invalid[0].error).not.toContain("\n");
    expect(await listEntries(dir)).toHaveLength(1);
  });

  it("orders same-day entries deterministically (by title, then id), independent of the filesystem", async () => {
    await writeEntry(dir, { ...BASE, title: "Beta", date: "2026-05-01", id: "mem_2" }, "b");
    await writeEntry(dir, { ...BASE, title: "Alpha", date: "2026-05-01", id: "mem_3" }, "a");
    await writeEntry(dir, { ...BASE, title: "Alpha", date: "2026-05-01", id: "mem_1" }, "a");
    await writeEntry(dir, { ...BASE, title: "Zed", date: "2026-06-01", id: "mem_4" }, "z");
    expect((await listEntries(dir)).map((e) => e.frontmatter.id)).toEqual(["mem_4", "mem_1", "mem_3", "mem_2"]);
  });

  it("writes an entry even when entries/ is missing, as in a fresh clone of a just-initialized store", async () => {
    // git doesn't track empty directories, so a clone can have .memory/config.json but no entries/.
    await rm(entriesDir(dir), { recursive: true, force: true });
    const entry = await writeEntry(dir, { ...BASE, title: "After clone" }, "works");
    expect((await readEntryFile(entry.filePath)).body).toBe("works");
  });
});

describe("initStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "whyanchor-init-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates entries/ with a .gitkeep so the empty store survives a commit and clone", async () => {
    await initStore(dir);
    expect(await readdir(entriesDir(dir))).toEqual([".gitkeep"]);
  });

  it("never overwrites an existing config, and repairs a store missing its entries/ folder", async () => {
    await initStore(dir);
    const configPath = path.join(dir, ".memory", "config.json");
    const config = await readFile(configPath, "utf8");

    await rm(entriesDir(dir), { recursive: true, force: true });
    const created = await initStore(dir);
    expect(created.map((p) => path.basename(p))).toEqual(["entries", ".gitkeep"]);
    expect(await readFile(configPath, "utf8")).toBe(config);
    expect(await initStore(dir)).toEqual([]);
  });

  it("does not list the placeholder as an entry", async () => {
    await initStore(dir);
    await mkdir(entriesDir(dir), { recursive: true });
    await expect(access(path.join(entriesDir(dir), ".gitkeep"))).resolves.toBeUndefined();
    expect(await listEntries(dir)).toEqual([]);
  });
});

describe("entry file names and dates", () => {
  it("never produces an empty slug or a double dash", () => {
    expect(entryFileName("2026-09-27", "日本語のタイトル", "mem_x")).toBe("2026-09-27-entry-mem_x.md");
    const long = entryFileName("2026-09-27", "Memory entries are markdown files with YAML frontmatter, one per file", "mem_x");
    expect(long).not.toMatch(/--/);
    expect(long).toBe("2026-09-27-memory-entries-are-markdown-files-with-yaml-frontmatter-one-mem_x.md");
  });

  it("uses the local calendar day, not the UTC one", () => {
    // 01:30 local time on Sep 27 is still Sep 26 in UTC for any timezone east of Greenwich.
    expect(localDate(new Date(2026, 8, 27, 1, 30))).toBe("2026-09-27");
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});
