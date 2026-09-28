import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryEntry } from "../src/core/schema.js";
import { MarkerError, renderMemorySection, upsertMarkedSection, upsertMemorySection } from "../src/generators/agentsFile.js";

function makeEntry(overrides: Partial<MemoryEntry["frontmatter"]> = {}, body = "Why we did it."): MemoryEntry {
  return {
    frontmatter: {
      id: "mem_test1",
      title: "Chose Postgres over Mongo",
      date: "2026-09-19",
      author: "kishore.k@dataflo.ai",
      tags: ["architecture"],
      refs: ["src/billing.ts"],
      supersedes: null,
      status: "active",
      commit: "abc123",
      fingerprint: {},
      last_checked: null,
      ...overrides,
    },
    body,
    filePath: "/tmp/whatever.md",
  };
}

describe("renderMemorySection", () => {
  it("renders a placeholder when there are no entries", () => {
    const section = renderMemorySection([]);
    expect(section).toContain("No memory entries yet");
    expect(section).toContain("<!-- whyanchor:start -->");
    expect(section).toContain("<!-- whyanchor:end -->");
  });

  it("groups entries by tag and includes title/refs", () => {
    const section = renderMemorySection([makeEntry()]);
    expect(section).toContain("### architecture");
    expect(section).toContain("Chose Postgres over Mongo");
    expect(section).toContain("src/billing.ts");
  });

  it("excludes superseded entries", () => {
    const section = renderMemorySection([makeEntry({ status: "superseded" })]);
    expect(section).toContain("No memory entries yet");
  });
});

describe("upsertMemorySection", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "whyanchor-test-"));
    filePath = path.join(dir, "CLAUDE.md");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the file when it does not exist", async () => {
    const result = await upsertMemorySection(filePath, "<!-- whyanchor:start -->\nhi\n<!-- whyanchor:end -->");
    expect(result).toBe("created");
    const content = await readFile(filePath, "utf8");
    expect(content).toContain("hi");
  });

  it("appends a marked section to an existing file without markers", async () => {
    await writeFile(filePath, "# My existing instructions\n\nDo the thing.\n", "utf8");
    const result = await upsertMemorySection(filePath, "<!-- whyanchor:start -->\nnew section\n<!-- whyanchor:end -->");
    expect(result).toBe("updated");
    const content = await readFile(filePath, "utf8");
    expect(content).toContain("My existing instructions");
    expect(content).toContain("new section");
  });

  it("replaces only the content between existing markers, preserving the rest", async () => {
    await writeFile(
      filePath,
      "# Header\n\n<!-- whyanchor:start -->\nold section\n<!-- whyanchor:end -->\n\n# Footer\n",
      "utf8"
    );
    await upsertMemorySection(filePath, "<!-- whyanchor:start -->\nnew section\n<!-- whyanchor:end -->");
    const content = await readFile(filePath, "utf8");
    expect(content).toContain("# Header");
    expect(content).toContain("# Footer");
    expect(content).toContain("new section");
    expect(content).not.toContain("old section");
  });

  it("ignores marker-like text inline in a body line and still finds the real end marker", async () => {
    // Regression: an entry whose body literally mentions "<!-- whyanchor:end -->" (e.g. one
    // documenting the marker scheme itself) must not be mistaken for the real closing marker.
    await writeFile(
      filePath,
      [
        "# Header",
        "<!-- whyanchor:start -->",
        "- explains the marker: text between <!-- whyanchor:start --> and <!-- whyanchor:end -->, ignored",
        "<!-- whyanchor:end -->",
        "# Footer",
        "",
      ].join("\n"),
      "utf8"
    );
    await upsertMemorySection(filePath, "<!-- whyanchor:start -->\nnew section\n<!-- whyanchor:end -->");
    const content = await readFile(filePath, "utf8");
    expect(content).toContain("# Header");
    expect(content).toContain("# Footer");
    expect(content).toContain("new section");
    expect(content).not.toContain("explains the marker");
    expect(content.match(/<!-- whyanchor:end -->/g)?.length).toBe(1);
  });

  it("refuses, without writing, when the end marker is gone — instead of later deleting hand-written text", async () => {
    // Regression: the first run appended a fresh block after the orphaned start marker; the second
    // run then replaced "first start … last end", wiping the hand-written section in between.
    const original = "# My notes\n\n<!-- whyanchor:start -->\n## Project Memory\nold stuff\n\n## Mine\nIMPORTANT: keep me\n";
    await writeFile(filePath, original, "utf8");
    const section = "<!-- whyanchor:start -->\nnew\n<!-- whyanchor:end -->";

    await expect(upsertMemorySection(filePath, section)).rejects.toThrow(MarkerError);
    await expect(upsertMemorySection(filePath, section)).rejects.toThrow(/expected exactly one of each/);
    expect(await readFile(filePath, "utf8")).toBe(original);
  });

  it("refuses an orphaned end marker, a duplicated block, and reversed markers", async () => {
    const section = "<!-- whyanchor:start -->\nnew\n<!-- whyanchor:end -->";
    for (const content of [
      "# Notes\n<!-- whyanchor:end -->\nmine\n",
      "<!-- whyanchor:start -->\na\n<!-- whyanchor:end -->\nmine\n<!-- whyanchor:start -->\nb\n<!-- whyanchor:end -->\n",
      "<!-- whyanchor:end -->\nmine\n<!-- whyanchor:start -->\n",
    ]) {
      await writeFile(filePath, content, "utf8");
      await expect(upsertMemorySection(filePath, section)).rejects.toThrow(MarkerError);
      expect(await readFile(filePath, "utf8")).toBe(content);
    }
  });

  it("keeps a CRLF file CRLF instead of mixing line endings", async () => {
    await writeFile(filePath, "# Team rules\r\n\r\nAlways run tests.\r\n", "utf8");
    await upsertMemorySection(filePath, "<!-- whyanchor:start -->\nnew section\n<!-- whyanchor:end -->");
    const content = await readFile(filePath, "utf8");
    expect(content).toContain("new section\r\n");
    expect(content.replace(/\r\n/g, "")).not.toContain("\n");

    // …and replacing the block later keeps it that way.
    await upsertMemorySection(filePath, "<!-- whyanchor:start -->\nnewer\n<!-- whyanchor:end -->");
    const again = await readFile(filePath, "utf8");
    expect(again).toContain("newer\r\n");
    expect(again.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("reports unchanged, and leaves the file alone, when there is nothing to update", async () => {
    const section = "<!-- whyanchor:start -->\nsame\n<!-- whyanchor:end -->";
    expect(await upsertMemorySection(filePath, section)).toBe("created");
    expect(await upsertMemorySection(filePath, section)).toBe("unchanged");
    expect(await upsertMemorySection(filePath, section.replace("same", "different"))).toBe("updated");
  });

  it("fills an empty existing file without leading blank lines", async () => {
    await writeFile(filePath, "", "utf8");
    await upsertMemorySection(filePath, "<!-- whyanchor:start -->\nx\n<!-- whyanchor:end -->");
    expect(await readFile(filePath, "utf8")).toBe("<!-- whyanchor:start -->\nx\n<!-- whyanchor:end -->\n");
  });

  it("inserts a new section above an anchor marker when asked", async () => {
    await writeFile(filePath, "# Title\n<!-- whyanchor:start -->\nmem\n<!-- whyanchor:end -->\n", "utf8");
    await upsertMarkedSection(filePath, "<!-- u:start -->\nusage\n<!-- u:end -->", {
      startMarker: "<!-- u:start -->",
      endMarker: "<!-- u:end -->",
      insertBefore: "<!-- whyanchor:start -->",
    });
    const content = await readFile(filePath, "utf8");
    expect(content.indexOf("usage")).toBeLessThan(content.indexOf("mem"));
    expect(content.startsWith("# Title\n")).toBe(true);
  });
});

describe("renderMemorySection — grouping and escaping", () => {
  it("lists a multi-tag entry once, under its first tag, with every tag in its meta line", () => {
    const section = renderMemorySection([makeEntry({ tags: ["db", "architecture", "perf"] })]);
    expect(section.match(/Chose Postgres over Mongo/g)).toHaveLength(1);
    expect(section).toContain("### db");
    expect(section).not.toContain("### architecture");
    expect(section).toContain("tags: db, architecture, perf");
  });

  it("files untagged entries under 'general'", () => {
    expect(renderMemorySection([makeEntry({ tags: [] })])).toContain("### general");
  });

  it("escapes a body line that is exactly a marker, so it can't be taken for the real one", async () => {
    const section = renderMemorySection([makeEntry({}, "<!-- whyanchor:end -->\nmore")]);
    const lines = section.split("\n").map((l) => l.trim());
    expect(lines.filter((l) => l === "<!-- whyanchor:end -->")).toHaveLength(1);
    expect(section).toContain("`<!-- whyanchor:end -->`");
  });

  it("flattens a multi-line title onto one line", () => {
    const section = renderMemorySection([makeEntry({ title: "Line one\nline two" })]);
    expect(section).toContain("- **Line one line two**");
  });
});
