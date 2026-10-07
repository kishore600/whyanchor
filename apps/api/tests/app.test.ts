import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("api", () => {
  const app = createApp({ service: "whyanchor-api", commit: "abc1234" });

  it("answers /healthz with the service name and commit", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "whyanchor-api", commit: "abc1234" });
  });

  it("returns 404 for unknown routes", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });
});
