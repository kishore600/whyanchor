import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  connectCodex,
  connectJsonAgent,
  ensureCursorRuleFile,
  formatCommand,
  hasLegacyRootClaudeFile,
  isEphemeralInstall,
  npxServerCommand,
  parseCommand,
  writeUsageInstructions,
} from "../src/generators/agentConfig.js";
import { upsertMarkedSection } from "../src/generators/agentsFile.js";

const SERVER = { command: "node", args: ["/abs/path/cli.js", "mcp"] };

describe("connectJsonAgent", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "whyanchor-connect-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates .mcp.json when none exists", async () => {
    const result = await connectJsonAgent(dir, "claude", SERVER);
    expect(result.action).toBe("created");
    const config = JSON.parse(await readFile(path.join(dir, ".mcp.json"), "utf8"));
    expect(config.mcpServers["whyanchor"]).toEqual(SERVER);
  });

  it("preserves other servers already configured", async () => {
    await writeFile(
      path.join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "existing-server": { command: "node", args: ["other.js"] } } }, null, 2),
      "utf8"
    );

    const result = await connectJsonAgent(dir, "claude", SERVER);
    expect(result.action).toBe("updated");

    const config = JSON.parse(await readFile(path.join(dir, ".mcp.json"), "utf8"));
    expect(config.mcpServers["existing-server"]).toEqual({ command: "node", args: ["other.js"] });
    expect(config.mcpServers["whyanchor"]).toEqual(SERVER);
  });

  it("preserves unrelated top-level keys", async () => {
    await writeFile(path.join(dir, ".mcp.json"), JSON.stringify({ someOtherKey: { a: 1 } }, null, 2), "utf8");
    await connectJsonAgent(dir, "claude", SERVER);
    const config = JSON.parse(await readFile(path.join(dir, ".mcp.json"), "utf8"));
    expect(config.someOtherKey).toEqual({ a: 1 });
  });

  it("is idempotent — re-running reports unchanged", async () => {
    await connectJsonAgent(dir, "claude", SERVER);
    const second = await connectJsonAgent(dir, "claude", SERVER);
    expect(second.action).toBe("unchanged");
  });

  it("refuses to overwrite a malformed config rather than clobbering it", async () => {
    await writeFile(path.join(dir, ".mcp.json"), "{ not valid json", "utf8");
    await expect(connectJsonAgent(dir, "claude", SERVER)).rejects.toThrow(/not valid JSON/);
    expect(await readFile(path.join(dir, ".mcp.json"), "utf8")).toBe("{ not valid json");
  });

  it("writes Cursor config to .cursor/mcp.json", async () => {
    await connectJsonAgent(dir, "cursor", SERVER);
    const config = JSON.parse(await readFile(path.join(dir, ".cursor", "mcp.json"), "utf8"));
    expect(config.mcpServers["whyanchor"]).toEqual(SERVER);
  });
});

describe("connectCodex", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "whyanchor-codex-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a TOML table when no config exists", async () => {
    const result = await connectCodex(dir, SERVER);
    expect(result.action).toBe("created");
    const toml = await readFile(path.join(dir, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("[mcp_servers.whyanchor]");
    expect(toml).toContain('command = "node"');
    expect(toml).toContain('args = ["/abs/path/cli.js", "mcp"]');
  });

  it("appends without disturbing other tables", async () => {
    await mkdir(path.join(dir, ".codex"), { recursive: true });
    await writeFile(
      path.join(dir, ".codex", "config.toml"),
      'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "node"\nargs = ["other.js"]\n',
      "utf8"
    );

    await connectCodex(dir, SERVER);
    const toml = await readFile(path.join(dir, ".codex", "config.toml"), "utf8");
    expect(toml).toContain('model = "gpt-5"');
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml).toContain("[mcp_servers.whyanchor]");
  });

  it("replaces an existing whyanchor table instead of duplicating it", async () => {
    await connectCodex(dir, SERVER);
    await connectCodex(dir, { command: "whyanchor", args: ["mcp"] });
    const toml = await readFile(path.join(dir, ".codex", "config.toml"), "utf8");
    expect(toml.match(/\[mcp_servers\.whyanchor\]/g)?.length).toBe(1);
    expect(toml).toContain('command = "whyanchor"');
    expect(toml).not.toContain("/abs/path/cli.js");
  });
});

describe("ensureCursorRuleFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "whyanchor-cursor-rule-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a .mdc file with the frontmatter Cursor requires", async () => {
    const filePath = await ensureCursorRuleFile(dir);
    expect(filePath.endsWith(".mdc")).toBe(true);

    const content = await readFile(filePath, "utf8");
    expect(content.startsWith("---")).toBe(true);
    expect(content).toContain("alwaysApply: true");
    expect(content).toContain("description:");
  });

  it("preserves frontmatter the user has customized", async () => {
    const filePath = path.join(dir, ".cursor", "rules", "whyanchor.mdc");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      '---\ndescription: my own wording\nglobs: ["src/**/*.ts"]\nalwaysApply: false\n---\n',
      "utf8"
    );

    await ensureCursorRuleFile(dir);
    const content = await readFile(filePath, "utf8");
    expect(content).toContain("my own wording");
    expect(content).toContain('globs: ["src/**/*.ts"]');
    expect(content).toContain("alwaysApply: false");
  });

  it("keeps frontmatter above the generated section when content is written into it", async () => {
    const filePath = await ensureCursorRuleFile(dir);
    await upsertMarkedSection(filePath, "<!-- whyanchor:start -->\nnotes here\n<!-- whyanchor:end -->");

    const content = await readFile(filePath, "utf8");
    expect(content.startsWith("---")).toBe(true);
    expect(content.indexOf("alwaysApply")).toBeLessThan(content.indexOf("notes here"));
    expect(content).toContain("notes here");
  });
});

describe("hasLegacyRootClaudeFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "whyanchor-legacy-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is false when no root CLAUDE.md exists", async () => {
    expect(await hasLegacyRootClaudeFile(dir)).toBe(false);
  });

  it("is false for a root CLAUDE.md that is purely hand-written", async () => {
    await writeFile(path.join(dir, "CLAUDE.md"), "# My own notes\n\nNothing to do with this tool.\n", "utf8");
    expect(await hasLegacyRootClaudeFile(dir)).toBe(false);
  });

  it("is true when a root CLAUDE.md carries our generated block", async () => {
    await writeFile(
      path.join(dir, "CLAUDE.md"),
      "<!-- whyanchor:start -->\n## Project Memory\n<!-- whyanchor:end -->\n",
      "utf8"
    );
    expect(await hasLegacyRootClaudeFile(dir)).toBe(true);
  });
});

describe("writeUsageInstructions", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "whyanchor-usage-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("inserts above an existing generated memory block, preserving hand-written content", async () => {
    await writeFile(
      path.join(dir, "CLAUDE.md"),
      "# My Project\n\nHand-written rules.\n\n<!-- whyanchor:start -->\n## Project Memory\n<!-- whyanchor:end -->\n",
      "utf8"
    );

    await writeUsageInstructions(dir, "CLAUDE.md");
    const content = await readFile(path.join(dir, "CLAUDE.md"), "utf8");

    expect(content).toContain("Hand-written rules.");
    expect(content).toContain("## Project Memory");
    expect(content.indexOf("whyanchor:usage:start")).toBeLessThan(content.indexOf("whyanchor:start"));
  });

  it("is idempotent — re-running does not duplicate the section", async () => {
    await writeUsageInstructions(dir, "CLAUDE.md");
    await writeUsageInstructions(dir, "CLAUDE.md");
    const content = await readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(content.match(/whyanchor:usage:start/g)?.length).toBe(1);
  });

  it("reports unchanged on a re-run instead of claiming an update", async () => {
    expect(await writeUsageInstructions(dir, "CLAUDE.md")).toBe("created");
    expect(await writeUsageInstructions(dir, "CLAUDE.md")).toBe("unchanged");
  });
});

describe("connectJsonAgent — configs it must not mangle", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "whyanchor-connect2-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("merges into a config saved with a UTF-8 BOM (Windows editors, PowerShell 5.1)", async () => {
    await writeFile(path.join(dir, ".mcp.json"), '\uFEFF{ "mcpServers": { "other": { "command": "x", "args": [] } } }', "utf8");
    const result = await connectJsonAgent(dir, "claude", SERVER);
    expect(result.action).toBe("updated");
    const config = JSON.parse(await readFile(path.join(dir, ".mcp.json"), "utf8"));
    expect(Object.keys(config.mcpServers).sort()).toEqual(["other", "whyanchor"]);
  });

  it("refuses valid JSON that isn't an object, and an mcpServers that isn't one", async () => {
    for (const content of ["[]", "null", '"text"', '{ "mcpServers": [] }', '{ "mcpServers": "x" }']) {
      await writeFile(path.join(dir, ".mcp.json"), content, "utf8");
      await expect(connectJsonAgent(dir, "claude", SERVER)).rejects.toThrow(ConfigError);
      expect(await readFile(path.join(dir, ".mcp.json"), "utf8")).toBe(content);
    }
  });

  it("keeps extra settings the user added to the whyanchor entry, like env", async () => {
    await writeFile(
      path.join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { whyanchor: { command: "old", args: [], env: { WHYANCHOR_DEBUG: "1" } } } }),
      "utf8"
    );
    await connectJsonAgent(dir, "claude", SERVER);
    const config = JSON.parse(await readFile(path.join(dir, ".mcp.json"), "utf8"));
    expect(config.mcpServers.whyanchor).toEqual({ ...SERVER, env: { WHYANCHOR_DEBUG: "1" } });
  });
});

describe("connectCodex — existing files", () => {
  let dir: string;
  const tomlPath = () => path.join(dir, ".codex", "config.toml");

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "whyanchor-codex2-"));
    await mkdir(path.join(dir, ".codex"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("replaces a table written with a quoted key rather than adding a duplicate (invalid TOML)", async () => {
    await writeFile(tomlPath(), '[mcp_servers."whyanchor"]\ncommand = "old"\nargs = []\n\n[mcp_servers.other]\ncommand = "o"\n', "utf8");
    await connectCodex(dir, SERVER);
    const toml = await readFile(tomlPath(), "utf8");
    expect(toml.match(/\[mcp_servers\.("?)whyanchor\1\]/g)).toHaveLength(1);
    expect(toml).toContain('command = "node"');
    expect(toml).toContain("[mcp_servers.other]");
  });

  it("keeps a CRLF file CRLF", async () => {
    await writeFile(tomlPath(), 'model = "gpt-5"\r\n\r\n[mcp_servers.whyanchor]\r\ncommand = "old"\r\nargs = []\r\n', "utf8");
    await connectCodex(dir, SERVER);
    const toml = await readFile(tomlPath(), "utf8");
    expect(toml).toContain('command = "node"\r\n');
    expect(toml.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("is unchanged on a re-run", async () => {
    await connectCodex(dir, SERVER);
    expect((await connectCodex(dir, SERVER)).action).toBe("unchanged");
  });
});

describe("server command helpers", () => {
  it("recognizes package-manager caches that get pruned", () => {
    expect(isEphemeralInstall("C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\a1b2\\node_modules\\whyanchor\\dist\\cli.js")).toBe(true);
    expect(isEphemeralInstall("/home/me/.npm/_npx/a1b2/node_modules/whyanchor/dist/cli.js")).toBe(true);
    expect(isEphemeralInstall("/home/me/.cache/pnpm/dlx/xyz/node_modules/whyanchor/dist/cli.js")).toBe(true);
    expect(isEphemeralInstall("/tmp/bunx-501-whyanchor@latest/node_modules/whyanchor/dist/cli.js")).toBe(true);
    expect(isEphemeralInstall("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\whyanchor\\dist\\cli.js")).toBe(false);
    expect(isEphemeralInstall("/usr/local/lib/node_modules/whyanchor/dist/cli.js")).toBe(false);
  });

  it("launches npx through cmd /c on Windows, directly elsewhere", () => {
    expect(npxServerCommand("win32")).toEqual({ command: "cmd", args: ["/c", "npx", "-y", "whyanchor", "mcp"] });
    expect(npxServerCommand("darwin")).toEqual({ command: "npx", args: ["-y", "whyanchor", "mcp"] });
  });

  it("parses --command with quoted arguments, and rejects an empty one", () => {
    expect(parseCommand('node "C:\\Program Files\\wa\\cli.js" mcp')).toEqual({ command: "node", args: ["C:\\Program Files\\wa\\cli.js", "mcp"] });
    expect(parseCommand("npx -y whyanchor mcp")).toEqual({ command: "npx", args: ["-y", "whyanchor", "mcp"] });
    expect(parseCommand("   ")).toBeNull();
    expect(formatCommand({ command: "node", args: ["C:\\Program Files\\x.js", "mcp"] })).toBe('node "C:\\Program Files\\x.js" mcp');
  });
});
