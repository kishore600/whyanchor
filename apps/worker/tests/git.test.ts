import { describe, expect, it } from "vitest";
import { gitVersion } from "../src/git.js";

describe("worker environment", () => {
  it("has git on PATH", async () => {
    expect(await gitVersion()).toMatch(/^git version \d+\.\d+/);
  });
});
