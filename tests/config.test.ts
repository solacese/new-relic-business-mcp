import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to mock mode", () => {
    const config = loadConfig({});

    expect(config.backendMode).toBe("mock");
    expect(config.defaultLookbackMinutes).toBe(120);
  });

  it("requires live credentials in New Relic mode", () => {
    expect(() =>
      loadConfig({
        BACKEND_MODE: "newrelic",
        NEW_RELIC_REGION: "US"
      })
    ).toThrow(/NEW_RELIC_USER_API_KEY/);
  });

  it("loads the optional MCP API key", () => {
    const config = loadConfig({
      MCP_API_KEY: "top-secret"
    });

    expect(config.auth.apiKey).toBe("top-secret");
  });
});
