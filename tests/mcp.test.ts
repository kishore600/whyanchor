import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEntry } from "../src/core/capture.js";
import { findEntryById } from "../src/core/store.js";
import { createMcpServer } from "../src/mcp/server.js";
import { makeRepo } from "./helpers.js";

interface ToolReply {
  isError: boolean;
  data: any;
}

/** Connects a real MCP client to the server in-process — the same protocol an agent speaks. */
async function connect(repoRoot: string) {
  const server = createMcpServer(repoRoot);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolReply> => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = res.content[0].text;
    // Tool results are JSON; argument-validation failures come back from the SDK as plain text.
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // keep the raw text
    }
    return { isError: Boolean(res.isError), data };
  };
  return { client, call };
}

const ids = (reply: ToolReply): string[] => reply.data.map((e: { id: string }) => e.id);

describe("MCP server", () => {
  let dir: string;
  let client: Client;
  let call: (name: string, args?: Record<string, unknown>) => Promise<ToolReply>;

  beforeEach(async () => {
    dir = await makeRepo("whyanchor-mcp-");
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "billing.ts"), "export function calculateTax(a) {\n  return a * 0.2;\n}\n", "utf8");
    ({ client, call } = await connect(dir));
  });

  afterEach(async () => {
    await client.close();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  describe("get_memory_for_file", () => {
    let symbolNote: string;
    let fileNote: string;

    beforeEach(async () => {
      symbolNote = (await captureEntry(dir, { title: "Tax", body: "b", refs: ["src/billing.ts#calculateTax"] })).entry.frontmatter.id;
      fileNote = (await captureEntry(dir, { title: "Billing", body: "b", refs: ["src/billing.ts"] })).entry.frontmatter.id;
      await captureEntry(dir, { title: "Other", body: "b", refs: ["src/other.ts"] });
    });

    it("matches however the agent spells the path — relative, ./, backslashes or absolute", async () => {
      // Regression: only the exact "src/billing.ts" form matched; absolute paths returned nothing.
      for (const p of ["src/billing.ts", "./src/billing.ts", "src\\billing.ts", path.join(dir, "src", "billing.ts")]) {
        expect(ids(await call("get_memory_for_file", { path: p })).sort(), p).toEqual([symbolNote, fileNote].sort());
      }
    });

    it("narrows to one symbol with file#symbol, keeping whole-file notes", async () => {
      // Regression: the documented file#symbol form never matched anything.
      expect(ids(await call("get_memory_for_file", { path: "src/billing.ts#calculateTax" })).sort()).toEqual([symbolNote, fileNote].sort());
      expect(ids(await call("get_memory_for_file", { path: "src/billing.ts#otherFn" }))).toEqual([fileNote]);
    });
  });

  describe("supersedes chains", () => {
    let oldId: string;
    let newId: string;
    let neighbourId: string;

    beforeEach(async () => {
      oldId = (await captureEntry(dir, { title: "Old rule", body: "b", refs: ["src/billing.ts"], tags: ["billing"] })).entry.frontmatter.id;
      newId = (await captureEntry(dir, { title: "New rule", body: "b", refs: ["src/billing.ts"], tags: ["billing"], supersedes: oldId })).entry
        .frontmatter.id;
      neighbourId = (await captureEntry(dir, { title: "Neighbour", body: "b", tags: ["billing"] })).entry.frontmatter.id;
    });

    it("returns the superseded entry through the supersedes chain", async () => {
      // Regression: superseded entries were filtered out first, so the chain never surfaced.
      const reply = await call("get_related_memory", { id: newId });
      const old = reply.data.find((e: { id: string }) => e.id === oldId);
      expect(old.reasons).toContain("supersedes chain");
      expect(old.status).toBe("superseded");
      expect(ids(reply)).toContain(neighbourId);
    });

    it("answers for a superseded id too — pointing at its replacement", async () => {
      const reply = await call("get_related_memory", { id: oldId });
      expect(reply.isError).toBe(false);
      expect(ids(reply)).toContain(newId);
    });

    it("shows both directions of the chain on get_memory_entry", async () => {
      expect((await call("get_memory_entry", { id: oldId })).data.superseded_by).toEqual([newId]);
      expect((await call("get_memory_entry", { id: newId })).data.supersedes).toBe(oldId);
    });

    it("keeps superseded entries out of search and file lookups", async () => {
      expect(ids(await call("search_memory", { query: "rule" }))).toEqual([newId]);
      expect(ids(await call("get_memory_for_file", { path: "src/billing.ts" }))).toEqual([newId]);
    });
  });

  describe("capture_memory", () => {
    it("tells the agent which refs can't be checked", async () => {
      const reply = await call("capture_memory", {
        title: "Agent note",
        body: "why",
        refs: ["src/billing.ts#calculateTax", "src/nope.ts", "src/billing.ts#gone"],
      });
      expect(reply.isError).toBe(false);
      expect(reply.data.warnings.join("\n")).toMatch(/src\/nope\.ts/);
      expect(reply.data.warnings.join("\n")).toMatch(/whole file instead: src\/billing\.ts#gone/);
      const entry = await findEntryById(dir, reply.data.created);
      expect(entry?.frontmatter.author).toBe("dev@example.com (via agent)");
    });

    it("lets an agent supersede a stale entry", async () => {
      const prior = await call("capture_memory", { title: "Rate is 20%", body: "b", refs: ["src/billing.ts#calculateTax"] });
      const reply = await call("capture_memory", { title: "Rate is 25%", body: "b", supersedes: prior.data.created });
      expect(reply.data.superseded).toBe(prior.data.created);
      expect((await findEntryById(dir, prior.data.created))?.frontmatter.status).toBe("superseded");
    });

    it("rejects empty titles, unknown supersedes ids and regex-hostile refs without crashing", async () => {
      expect((await call("capture_memory", { title: "  ", body: "b" })).isError).toBe(true);
      expect((await call("capture_memory", { title: "t", body: "b", supersedes: "mem_nope" })).isError).toBe(true);
      expect((await call("capture_memory", { title: "t", body: "b", refs: ["src/billing.ts#git("] })).isError).toBe(false);
    });
  });

  it("flags an unknown id as an error rather than an empty success", async () => {
    expect((await call("get_memory_entry", { id: "mem_nope" })).isError).toBe(true);
    expect((await call("get_related_memory", { id: "mem_nope" })).isError).toBe(true);
  });
});

describe("MCP server without a memory store", () => {
  it("says so instead of answering [] — the usual cause is a server launched outside the repo", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "whyanchor-mcp-nostore-"));
    const { client, call } = await connect(dir);
    try {
      for (const tool of ["search_memory", "list_stale_memory"]) {
        const reply = await call(tool);
        expect(reply.isError).toBe(true);
        expect(reply.data.error).toMatch(/No whyanchor memory store/);
      }
      const capture = await call("capture_memory", { title: "t", body: "b" });
      expect(capture.isError).toBe(true);
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
