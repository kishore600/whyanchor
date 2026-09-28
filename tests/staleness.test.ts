import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeFingerprint, extractSymbolBlock, hashContent } from "../src/core/fingerprint.js";
import { getCurrentCommit } from "../src/core/git.js";
import { legacySymbolHashes } from "../src/core/legacyFingerprint.js";
import type { FingerprintEntry } from "../src/core/schema.js";
import { checkEntry } from "../src/core/staleness.js";
import { initStore, writeEntry } from "../src/core/store.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

describe("staleness check (integration, real git repo)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "whyanchor-stale-"));
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "test@example.com"]);
    await git(dir, ["config", "user.name", "Test"]);
    await initStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports fresh when the referenced file has not changed since capture", async () => {
    const filePath = path.join(dir, "billing.ts");
    await writeFile(filePath, "function calculateTax(a) {\n  return a * 0.2;\n}\n", "utf8");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "add billing"]);

    const commit = await getCurrentCommit(dir);
    const fp = await computeFingerprint(dir, "billing.ts#calculateTax");
    const entry = await writeEntry(
      dir,
      {
        title: "Tax rate is 20%",
        author: "test",
        tags: [],
        refs: ["billing.ts#calculateTax"],
        supersedes: null,
        status: "active",
        commit,
        fingerprint: { "billing.ts#calculateTax": fp },
        last_checked: null,
      },
      "Flat 20% tax rate for now."
    );

    const result = await checkEntry(dir, entry);
    expect(result.level).toBe("fresh");
  });

  it("flags high when the referenced symbol's content changes", async () => {
    const filePath = path.join(dir, "billing.ts");
    await writeFile(filePath, "function calculateTax(a) {\n  return a * 0.2;\n}\n", "utf8");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "add billing"]);

    const commit = await getCurrentCommit(dir);
    const fp = await computeFingerprint(dir, "billing.ts#calculateTax");
    const entry = await writeEntry(
      dir,
      {
        title: "Tax rate is 20%",
        author: "test",
        tags: [],
        refs: ["billing.ts#calculateTax"],
        supersedes: null,
        status: "active",
        commit,
        fingerprint: { "billing.ts#calculateTax": fp },
        last_checked: null,
      },
      "Flat 20% tax rate for now."
    );

    await writeFile(filePath, "function calculateTax(a) {\n  return a * 0.25;\n}\n", "utf8");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "bump tax rate"]);

    const result = await checkEntry(dir, entry);
    expect(result.level).toBe("high");
    expect(result.refs[0].level).toBe("high");
  });

  it("flags low when the file was touched but the referenced symbol is unchanged", async () => {
    const filePath = path.join(dir, "billing.ts");
    await writeFile(
      filePath,
      "function calculateTax(a) {\n  return a * 0.2;\n}\n\nfunction other() {\n  return 1;\n}\n",
      "utf8"
    );
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "add billing"]);

    const commit = await getCurrentCommit(dir);
    const fp = await computeFingerprint(dir, "billing.ts#calculateTax");
    const entry = await writeEntry(
      dir,
      {
        title: "Tax rate is 20%",
        author: "test",
        tags: [],
        refs: ["billing.ts#calculateTax"],
        supersedes: null,
        status: "active",
        commit,
        fingerprint: { "billing.ts#calculateTax": fp },
        last_checked: null,
      },
      "Flat 20% tax rate for now."
    );

    await writeFile(
      filePath,
      "function calculateTax(a) {\n  return a * 0.2;\n}\n\nfunction other() {\n  return 2;\n}\n",
      "utf8"
    );
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "change unrelated function"]);

    const result = await checkEntry(dir, entry);
    expect(result.level).toBe("low");
  });

  it("flags missing when the referenced symbol is removed", async () => {
    const filePath = path.join(dir, "billing.ts");
    await writeFile(filePath, "function calculateTax(a) {\n  return a * 0.2;\n}\n", "utf8");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "add billing"]);

    const commit = await getCurrentCommit(dir);
    const fp = await computeFingerprint(dir, "billing.ts#calculateTax");
    const entry = await writeEntry(
      dir,
      {
        title: "Tax rate is 20%",
        author: "test",
        tags: [],
        refs: ["billing.ts#calculateTax"],
        supersedes: null,
        status: "active",
        commit,
        fingerprint: { "billing.ts#calculateTax": fp },
        last_checked: null,
      },
      "Flat 20% tax rate for now."
    );

    await writeFile(filePath, "function computeTax(a) {\n  return a * 0.2;\n}\n", "utf8");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "rename function"]);

    const result = await checkEntry(dir, entry);
    expect(result.level).toBe("missing");
  });
});

describe("staleness check — checkouts, history rewrites and baselines (integration)", () => {
  let dir: string;
  const LF = "function calculateTax(a) {\n  return a * 0.2;\n}\n\nfunction other() {\n  return 1;\n}\n";
  const CRLF = LF.replace(/\n/g, "\r\n");

  async function commitFile(content: string, message: string): Promise<string> {
    await writeFile(path.join(dir, "billing.ts"), content, "utf8");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", message]);
    return (await getCurrentCommit(dir))!;
  }

  function entryFor(ref: string, fingerprint: FingerprintEntry, commit: string | null) {
    return writeEntry(
      dir,
      {
        title: "Tax rate is 20%",
        author: "test",
        tags: [],
        refs: [ref],
        supersedes: null,
        status: "active",
        commit,
        fingerprint: { [ref]: fingerprint },
        last_checked: null,
      },
      "Flat 20% tax rate for now."
    );
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "whyanchor-stale2-"));
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "test@example.com"]);
    await git(dir, ["config", "user.name", "Test"]);
    // Keep the working tree byte-for-byte what each test writes, whatever the machine's git config.
    await git(dir, ["config", "core.autocrlf", "false"]);
    await initStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stays fresh when a note captured on an LF checkout is checked on a CRLF one", async () => {
    // Regression: hashes covered raw bytes, so every note went [STALE] on the other platform.
    const commit = await commitFile(LF, "add billing");
    const fp = await computeFingerprint(dir, "billing.ts#calculateTax");
    const fileFp = await computeFingerprint(dir, "billing.ts");
    const entry = await entryFor("billing.ts#calculateTax", fp, commit);
    const fileEntry = await entryFor("billing.ts", fileFp, commit);

    await writeFile(path.join(dir, "billing.ts"), CRLF, "utf8");
    expect((await checkEntry(dir, entry)).level).toBe("fresh");
    expect((await checkEntry(dir, fileEntry)).level).toBe("fresh");
  });

  it("keeps notes recorded by older versions (raw CRLF hash) fresh on the checkout they came from", async () => {
    const commit = await commitFile(CRLF, "add billing");
    const legacy = { hash: hashContent(extractSymbolBlock(CRLF, "calculateTax")!), kind: "symbol" as const };
    const entry = await entryFor("billing.ts#calculateTax", legacy, commit);
    expect((await checkEntry(dir, entry)).level).toBe("fresh");
  });

  it("still flags a real change on a CRLF checkout", async () => {
    const commit = await commitFile(CRLF, "add billing");
    const entry = await entryFor("billing.ts#calculateTax", await computeFingerprint(dir, "billing.ts#calculateTax"), commit);
    await writeFile(path.join(dir, "billing.ts"), CRLF.replace("0.2", "0.25"), "utf8");
    expect((await checkEntry(dir, entry)).level).toBe("high");
  });

  it("says so, instead of claiming 0 commits, when the capture commit is no longer in history", async () => {
    await commitFile(LF, "add billing");
    const fp = await computeFingerprint(dir, "billing.ts#calculateTax");
    const rewritten = "0123456789abcdef0123456789abcdef01234567";
    const entry = await entryFor("billing.ts#calculateTax", fp, rewritten);

    const fresh = await checkEntry(dir, entry);
    expect(fresh.level).toBe("fresh");
    expect(fresh.refs[0].commitsSince).toBeNull();

    await writeFile(path.join(dir, "billing.ts"), LF.replace("0.2", "0.3"), "utf8");
    const stale = await checkEntry(dir, entry);
    expect(stale.level).toBe("high");
    expect(stale.refs[0].reason).toMatch(/not in this clone's history/);
    expect(stale.refs[0].reason).not.toMatch(/0 commits/);
  });

  it("compares a symbol ref that fell back to the whole file as a whole file", async () => {
    const commit = await commitFile(LF, "add billing");
    const fp = await computeFingerprint(dir, "billing.ts#noSuchSymbol");
    expect(fp).toMatchObject({ kind: "file", fellBack: true });
    const entry = await entryFor("billing.ts#noSuchSymbol", { hash: fp.hash, kind: fp.kind }, commit);

    expect((await checkEntry(dir, entry)).level).toBe("fresh");
    await writeFile(path.join(dir, "billing.ts"), LF.replace("return 1;", "return 2;"), "utf8");
    const result = await checkEntry(dir, entry);
    expect(result.level).toBe("high");
    expect(result.refs[0].reason).toMatch(/whole file/);
  });

  it("explains a ref that never resolved (no baseline) rather than calling it a content change", async () => {
    const commit = await commitFile(LF, "add billing");
    const entry = await entryFor("billing.ts#calculateTax", { hash: "", kind: "missing" }, commit);
    const result = await checkEntry(dir, entry);
    expect(result.level).toBe("missing");
    expect(result.refs[0].reason).toMatch(/no baseline/);
  });

  describe("baselines recorded by the earlier symbol extractor", () => {
    // That extractor took the braces of a destructured / `= {}` parameter for the body, so its
    // fingerprint of this function covered only the signature line.
    const DESTRUCTURED = "export function Button({ label }: Props) {\n  return label;\n}\n";

    it("reports a partial old baseline as low-confidence with a re-anchor hint, not as changed", async () => {
      const commit = await commitFile(DESTRUCTURED, "add button");
      const [oldHash] = legacySymbolHashes(DESTRUCTURED, "Button");
      expect(oldHash).not.toBe(hashContent(extractSymbolBlock(DESTRUCTURED, "Button")!));
      const entry = await entryFor("billing.ts#Button", { hash: oldHash, kind: "symbol" }, commit);

      const result = await checkEntry(dir, entry);
      expect(result.level).toBe("low");
      expect(result.refs[0].reason).toMatch(/supersede the note to re-anchor it/);
    });

    it("still flags a change to the part the old baseline did cover", async () => {
      const commit = await commitFile(DESTRUCTURED, "add button");
      const [oldHash] = legacySymbolHashes(DESTRUCTURED, "Button");
      const entry = await entryFor("billing.ts#Button", { hash: oldHash, kind: "symbol" }, commit);
      await writeFile(path.join(dir, "billing.ts"), DESTRUCTURED.replace("{ label }", "{ label, icon }"), "utf8");
      expect((await checkEntry(dir, entry)).level).toBe("high");
    });

    it("stays plainly fresh where the old and new extractors agree", async () => {
      const commit = await commitFile(LF, "add billing");
      const [oldHash] = legacySymbolHashes(LF, "calculateTax");
      const entry = await entryFor("billing.ts#calculateTax", { hash: oldHash, kind: "symbol" }, commit);
      expect((await checkEntry(dir, entry)).level).toBe("fresh");
    });
  });

  it("reports a deleted file as missing", async () => {
    const commit = await commitFile(LF, "add billing");
    const entry = await entryFor("billing.ts", await computeFingerprint(dir, "billing.ts"), commit);
    await rm(path.join(dir, "billing.ts"));
    const result = await checkEntry(dir, entry);
    expect(result.level).toBe("missing");
    expect(result.refs[0].reason).toMatch(/no longer exists/);
  });
});
