import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// We need to test config in isolation with temp dirs
describe("config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "miclaw-config-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loadConfig uses defaults when no file exists", async () => {
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig(path.join(tempDir, "nonexistent.json"));
    expect(config.defaultAgent).toBe("assistant");
    expect(config.defaultModel).toBe("sonnet");
    expect(config.channels.web.port).toBe(3456);
    expect(config.maxConcurrentProcesses).toBe(5);
    expect(config.learning.model).toBe("haiku");
  });

  it("loadConfig merges custom values over defaults", async () => {
    const configPath = path.join(tempDir, "miclaw.json");
    writeFileSync(configPath, JSON.stringify({
      defaultModel: "opus",
      journalDays: 7,
      channels: { web: { port: 9999 } },
    }));
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig(configPath);
    expect(config.defaultModel).toBe("opus");
    expect(config.journalDays).toBe(7);
    expect(config.channels.web.port).toBe(9999);
    // Defaults preserved
    expect(config.defaultAgent).toBe("assistant");
  });

  it("loadConfig throws ConfigError on invalid JSON", async () => {
    const configPath = path.join(tempDir, "miclaw.json");
    writeFileSync(configPath, "not json {{{");
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig(configPath)).toThrow();
  });

  it("getSecurityProfile returns correct defaults per channel", async () => {
    const { loadConfig, getSecurityProfile } = await import("../src/config.js");
    const config = loadConfig(path.join(tempDir, "nonexistent.json"));

    const cli = getSecurityProfile("cli", config);
    expect(cli.requireAuth).toBe(false);
    expect(cli.allowedTools).toEqual([]);
    expect(cli.agentWriteToMemoryEnabled).toBe(true);

    const web = getSecurityProfile("web", config);
    expect(web.maxMessageLength).toBe(50_000);
    expect(web.agentWriteToMemoryEnabled).toBe(false);
    expect(web.allowedTools).toContain("Read");

    const cron = getSecurityProfile("cron", config);
    expect(cron.learningEnabled).toBe(false);
    expect(cron.maxTimeoutMs).toBe(600_000);
  });

  it("getSecurityProfile includes security defaults", async () => {
    const { loadConfig, getSecurityProfile } = await import("../src/config.js");
    const config = loadConfig(path.join(tempDir, "nonexistent.json"));

    const web = getSecurityProfile("web", config);
    expect(web.allowedPaths).toEqual([]);
    expect(web.blockedPaths).toEqual([]);
    expect(web.allowedUrls).toEqual([]);
    expect(web.blockedUrls).toEqual([]);
    expect(web.maxCostPerRequest).toBe(0);
    expect(web.rateLimitPerMinute).toBe(60);
    expect(web.auditEnabled).toBe(true);

    const cli = getSecurityProfile("cli", config);
    expect(cli.rateLimitPerMinute).toBe(0); // unlimited for local user
    expect(cli.auditEnabled).toBe(true);

    const cron = getSecurityProfile("cron", config);
    expect(cron.rateLimitPerMinute).toBe(0); // unlimited for system
    expect(cron.auditEnabled).toBe(true);
  });

  it("resolves env vars in apiKey", async () => {
    process.env.TEST_MICLAW_KEY = "secret123";
    const configPath = path.join(tempDir, "miclaw.json");
    writeFileSync(configPath, JSON.stringify({
      channels: { web: { auth: { type: "api-key", apiKey: "${TEST_MICLAW_KEY}" } } },
    }));
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig(configPath);
    expect(config.channels.web.auth.apiKey).toBe("secret123");
    delete process.env.TEST_MICLAW_KEY;
  });
});
