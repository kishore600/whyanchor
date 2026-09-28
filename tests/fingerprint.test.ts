import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractSymbolBlock,
  fingerprintContent,
  hashContent,
  normalizeContent,
  normalizeRef,
  parseRef,
} from "../src/core/fingerprint.js";

describe("parseRef", () => {
  it("splits file and symbol on #", () => {
    expect(parseRef("src/billing.ts#calculateTax")).toEqual({ file: "src/billing.ts", symbol: "calculateTax" });
  });

  it("returns null symbol when there is no #", () => {
    expect(parseRef("src/billing.ts")).toEqual({ file: "src/billing.ts", symbol: null });
  });
});

describe("hashContent", () => {
  it("is deterministic and sensitive to content changes", () => {
    const a = hashContent("hello world");
    const b = hashContent("hello world");
    const c = hashContent("hello world!");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("extractSymbolBlock", () => {
  it("extracts a JS function declaration", () => {
    const src = [
      "export function unrelated() {",
      "  return 1;",
      "}",
      "",
      "function calculateTax(amount) {",
      "  return amount * 0.2;",
      "}",
    ].join("\n");
    const block = extractSymbolBlock(src, "calculateTax");
    expect(block).toContain("function calculateTax(amount)");
    expect(block).toContain("return amount * 0.2;");
    expect(block).not.toContain("unrelated");
  });

  it("extracts a TS const arrow function", () => {
    const src = ["const foo = 1;", "", "const calculateTax = (amount: number) => {", "  return amount * 0.2;", "};"].join(
      "\n"
    );
    const block = extractSymbolBlock(src, "calculateTax");
    expect(block).toContain("calculateTax");
    expect(block).toContain("return amount * 0.2;");
  });

  it("extracts a Python function by indentation", () => {
    const src = [
      "def unrelated():",
      "    return 1",
      "",
      "def calculate_tax(amount):",
      "    total = amount * 0.2",
      "    return total",
      "",
      "def after():",
      "    pass",
    ].join("\n");
    const block = extractSymbolBlock(src, "calculate_tax");
    expect(block).toContain("def calculate_tax(amount):");
    expect(block).toContain("return total");
    expect(block).not.toContain("def after");
  });

  it("extracts a function whose signature spans many lines (opening brace far from the declaration)", () => {
    const src = [
      "export async function checkRef(",
      "  repoRoot: string,",
      "  ref: string,",
      "  capturedCommit: string | null,",
      "  capturedHash: string",
      "): Promise<string> {",
      "  return 'original';",
      "}",
    ].join("\n");
    const block = extractSymbolBlock(src, "checkRef");
    expect(block).toContain("return 'original';");

    const changed = src.replace("return 'original';", "return 'changed';");
    const changedBlock = extractSymbolBlock(changed, "checkRef");
    expect(hashContent(block!)).not.toBe(hashContent(changedBlock!));
  });

  it("returns null when the symbol cannot be found", () => {
    expect(extractSymbolBlock("const a = 1;", "doesNotExist")).toBeNull();
  });

  it("changes hash when the extracted block body changes", () => {
    const before = extractSymbolBlock("function calculateTax(a) {\n  return a * 0.2;\n}", "calculateTax")!;
    const after = extractSymbolBlock("function calculateTax(a) {\n  return a * 0.25;\n}", "calculateTax")!;
    expect(hashContent(before)).not.toBe(hashContent(after));
  });
});

/** Asserts the extracted block covers `body` (so edits to it are detected) and excludes `not`. */
function expectBlock(src: string[], symbol: string, body: string, not?: string): string {
  const block = extractSymbolBlock(src.join("\n"), symbol);
  expect(block, `no block found for ${symbol}`).not.toBeNull();
  expect(block).toContain(body);
  if (not) expect(block).not.toContain(not);
  return block!;
}

describe("extractSymbolBlock — languages the README promises", () => {
  it("Go func with a return type", () => {
    expectBlock(["func ParseConfig(path string) (*Config, error) {", "\treturn load(path)", "}"], "ParseConfig", "return load(path)");
  });

  it("Go method with a receiver", () => {
    expectBlock(["func (s *Server) Start() error {", "\treturn s.listen()", "}"], "Start", "return s.listen()");
  });

  it("Go type declaration", () => {
    expectBlock(["type Config struct {", "\tPort int", "}"], "Config", "Port int");
  });

  it("Java method with a throws clause, including when it wraps to the next line", () => {
    expectBlock(["  public String readAll(Path p) throws IOException {", "    return Files.readString(p);", "  }"], "readAll", "Files.readString");
    expectBlock(["  public String readAll(Path p)", "      throws IOException {", "    return Files.readString(p);", "  }"], "readAll", "Files.readString");
  });

  it("Java generic method", () => {
    expectBlock(["  public static <T> List<T> of(T item) {", "    return List.of(item);", "  }"], "of", "List.of(item)");
  });

  it("C# method with Allman braces", () => {
    expectBlock(
      ["    public decimal CalculateTax(decimal amount)", "    {", "        return amount * 0.2m;", "    }"],
      "CalculateTax",
      "amount * 0.2m"
    );
  });

  it("Python def with a multi-line (black-style) signature", () => {
    expectBlock(
      ["def calculate_tax(", "    amount: float,", "    rate: float = 0.2,", ") -> float:", "    return amount * rate", "", "def other():", "    return 1"],
      "calculate_tax",
      "return amount * rate",
      "def other"
    );
  });

  it("Python def whose default argument is a dict literal", () => {
    expectBlock(["def configure(opts={}):", "    opts.setdefault('a', 1)", "    return opts", "", "x = 1"], "configure", "return opts", "x = 1");
  });

  it("Python class, and a module-level constant", () => {
    expectBlock(["class Billing(Base):", "    rate = 0.2", "", "    def tax(self):", "        return 1", "", "OTHER = 2"], "Billing", "def tax", "OTHER");
    expectBlock(["TAX_RATE = 0.2", "", "def tax(a):", "    return a * TAX_RATE"], "TAX_RATE", "TAX_RATE = 0.2", "def tax");
  });

  it("TS interface, type alias and enum", () => {
    expectBlock(["export interface Options {", "  verbose: boolean;", "}"], "Options", "verbose: boolean;");
    expectBlock(["export type Level =", "  | 'low'", "  | 'high';", "", "export const x = 1;"], "Level", "'high'", "export const x");
    expectBlock(["export enum Color {", "  Red,", "}"], "Color", "Red");
  });

  it("TS class method whose parameters wrap across lines", () => {
    expectBlock(["class View {", "  render(", "    props: Props,", "    ctx: Ctx", "  ): string {", "    return tpl(props);", "  }", "}"], "render", "return tpl(props);");
  });

  it("Ruby method delimited by indentation and `end`", () => {
    expectBlock(["class Billing", "  def tax(amount)", "    amount * RATE", "  end", "", "  def other", "  end", "end"], "tax", "amount * RATE", "def other");
  });

  it("Rust and Kotlin functions", () => {
    expectBlock(["pub fn parse(input: &str) -> Result<Ast, Error> {", "    Parser::new(input).run()", "}"], "parse", "Parser::new");
    expectBlock(["fun total(items: List<Item>): Int {", "    return items.sumOf { it.price }", "}"], "total", "sumOf");
  });
});

describe("extractSymbolBlock — block boundaries", () => {
  it("stops a one-liner at its semicolon instead of bleeding into the next function", () => {
    expectBlock(
      ["export const TAX_RATE = 0.2;", "", "export function calculateTax(a: number) {", "  return a * TAX_RATE;", "}"],
      "TAX_RATE",
      "TAX_RATE = 0.2",
      "calculateTax"
    );
  });

  it("stops a semicolon-free one-liner at the end of its line", () => {
    expectBlock(["export const TAX_RATE = 0.2", "export function calculateTax(a) {", "  return a * TAX_RATE", "}"], "TAX_RATE", "0.2", "calculateTax");
  });

  it("covers the body of a function with destructured or object-typed parameters", () => {
    // Regression: the first `{` used to be the destructuring pattern, so only the signature was hashed.
    expectBlock(["export function Button({ label, onClick }: Props) {", "  return <button onClick={onClick}>{label}</button>;", "}"], "Button", "<button");
    expectBlock(
      ["export async function writeEntry(", "  root: string,", "  fm: Base & { id?: string; date?: string },", "): Promise<void> {", "  await save(fm);", "}"],
      "writeEntry",
      "await save(fm);"
    );
    expectBlock(["function upsert(path: string, options: Opts = {}): void {", "  write(path, options);", "}"], "upsert", "write(path, options);");
  });

  it("folds TS overload signatures into the implementation", () => {
    const block = expectBlock(
      ["export function parse(input: string): Ast;", "export function parse(input: Buffer): Ast;", "export function parse(input: string | Buffer): Ast {", "  return run(input);", "}"],
      "parse",
      "return run(input);"
    );
    expect(block).toContain("input: Buffer");
  });

  it("covers a whole multi-line call assigned to a const, including its trailing arguments", () => {
    expectBlock(["const matches = useCallback(", "  (node) => node.ok,", "  [search]", ");", "const other = 1;"], "matches", "[search]", "other");
  });

  it("prefers the real declaration over an earlier call site", () => {
    expectBlock(["const s = ok ? fmt(x) : '';", "", "function fmt(v) {", "  return String(v);", "}"], "fmt", "return String(v);", "ok ?");
    expectBlock(["function run() {", "  return fmt(1);", "}", "", "function fmt(v) {", "  return String(v);", "}"], "fmt", "return String(v);", "run()");
  });

  it("ignores declarations mentioned in comments and strings", () => {
    const src = ["// see function calculateTax below", 'const doc = "the type Options is gone";', "", "function calculateTax(a) {", "  return a;", "}"];
    expectBlock(src, "calculateTax", "return a;", "see function");
    expect(extractSymbolBlock(["// function ghost() {}", "const x = 1;"].join("\n"), "ghost")).toBeNull();
  });

  it("returns the same block for CRLF and LF content, apart from the line endings", () => {
    const lf = ["function calculateTax(a) {", "  return a * 0.2;", "}", "", "function other() {}"].join("\n");
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(extractSymbolBlock(crlf, "calculateTax")!.replace(/\r/g, "")).toBe(extractSymbolBlock(lf, "calculateTax"));
  });
});

describe("extractSymbolBlock — symbol names", () => {
  it("does not throw on regex metacharacters in the symbol", () => {
    expect(() => extractSymbolBlock("function git(a) {}", "git(")).not.toThrow();
    expect(() => extractSymbolBlock("function git(a) {}", "a[b")).not.toThrow();
    expect(extractSymbolBlock("function git(a) {}", "git(")).toBeNull();
  });

  it("finds JS identifiers containing $", () => {
    expectBlock(["export function $formatPrice(n) {", "  return n.toFixed(2);", "}"], "$formatPrice", "toFixed");
    expectBlock(["const jQuery$ = () => {", "  return 1;", "};"], "jQuery$", "return 1;");
  });

  it("does not match a symbol that is only a prefix or suffix of another identifier", () => {
    expect(extractSymbolBlock("function calculateTaxes(a) {\n  return a;\n}", "calculateTax")).toBeNull();
    expect(extractSymbolBlock("function $calculateTax(a) {\n  return a;\n}", "calculateTax")).toBeNull();
  });
});

describe("normalizeContent", () => {
  it("strips a BOM and converts CRLF / CR line endings to LF", () => {
    expect(normalizeContent("﻿a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });
});

describe("fingerprintContent", () => {
  const lf = "function calculateTax(a) {\n  return a * 0.2;\n}\n";
  const crlf = lf.replace(/\n/g, "\r\n");

  it("hashes identically whatever the checkout's line endings or BOM", () => {
    expect(fingerprintContent(crlf, "calculateTax").hash).toBe(fingerprintContent(lf, "calculateTax").hash);
    expect(fingerprintContent("﻿" + lf, null).hash).toBe(fingerprintContent(lf, null).hash);
    expect(fingerprintContent(crlf, null).hash).toBe(fingerprintContent(lf, null).hash);
  });

  it("reports the raw-bytes hash that versions before normalization recorded, only when it differs", () => {
    const legacyBlock = extractSymbolBlock(crlf, "calculateTax")!;
    expect(fingerprintContent(crlf, "calculateTax").legacyHash).toBe(hashContent(legacyBlock));
    expect(fingerprintContent(crlf, null).legacyHash).toBe(hashContent(crlf));
    expect(fingerprintContent(lf, "calculateTax").legacyHash).toBeUndefined();
  });

  it("falls back to the whole file when a symbol can't be found (auto mode)", () => {
    const result = fingerprintContent(lf, "noSuchSymbol");
    expect(result).toMatchObject({ kind: "file", fellBack: true, hash: hashContent(lf) });
  });

  it("reports a vanished symbol as missing in symbol mode, and hashes the whole file in file mode", () => {
    expect(fingerprintContent(lf, "noSuchSymbol", "symbol")).toEqual({ hash: "", kind: "missing" });
    expect(fingerprintContent(lf, "calculateTax", "file")).toMatchObject({ kind: "file", hash: hashContent(lf) });
  });
});

describe("normalizeRef", () => {
  const root = path.resolve("/repo");

  it("canonicalizes ./, backslashes and absolute paths inside the repo, keeping the symbol", () => {
    expect(normalizeRef(root, "./src/billing.ts")).toBe("src/billing.ts");
    expect(normalizeRef(root, "src\\core\\billing.ts#calculateTax")).toBe("src/core/billing.ts#calculateTax");
    expect(normalizeRef(root, path.join(root, "src", "billing.ts") + "#tax ")).toBe("src/billing.ts#tax");
  });

  it("leaves a path outside the repo pointing where it did", () => {
    expect(normalizeRef(root, "../other/x.ts")).toBe("../other/x.ts");
  });
});
