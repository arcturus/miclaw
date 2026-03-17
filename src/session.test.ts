import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "./session.js";
import type { MikeClawConfig } from "./config.js";

function makeConfig(sessionsDir: string): MikeClawConfig {
  return {
    sessionsDir,
    maxTurnsPerSession: 5,
    sessionTtlDays: 30,
  } as MikeClawConfig;
}

// Mock resolvePath
import { vi } from "vitest";
vi.mock("./config.js", () => ({
  resolvePath: (p: string) => p,
}));

describe("SessionManager", () => {
  let tempDir: string;
  let sm: SessionManager;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mikeclaw-session-"));
    sm = new SessionManager(makeConfig(tempDir));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("getOrCreate creates new session with correct fields", () => {
    const session = sm.getOrCreate("cli", "local", "assistant");
    expect(session.id).toBe("cli:local:assistant");
    expect(session.channelId).toBe("cli");
    expect(session.userId).toBe("local");
    expect(session.agentId).toBe("assistant");
    expect(session.claudeSessionId).toBeNull();
    expect(session.turnCount).toBe(0);
  });

  it("getOrCreate returns existing session on second call", () => {
    const s1 = sm.getOrCreate("cli", "local", "assistant");
    s1.turnCount = 5;
    const s2 = sm.getOrCreate("cli", "local", "assistant");
    expect(s2.turnCount).toBe(5);
    expect(s2).toBe(s1);
  });

  it("update modifies session fields", () => {
    sm.getOrCreate("cli", "local", "assistant");
    sm.update("cli:local:assistant", {
      claudeSessionId: "abc-123",
      turnCount: 3,
    });
    const session = sm.get("cli:local:assistant");
    expect(session?.claudeSessionId).toBe("abc-123");
    expect(session?.turnCount).toBe(3);
  });

  it("needsRotation returns true at boundary", () => {
    const session = sm.getOrCreate("cli", "local", "assistant");
    session.turnCount = 4;
    expect(sm.needsRotation(session)).toBe(false);
    session.turnCount = 5;
    expect(sm.needsRotation(session)).toBe(true);
  });

  it("rotate resets claudeSessionId and turnCount", () => {
    const session = sm.getOrCreate("cli", "local", "assistant");
    session.claudeSessionId = "abc-123";
    session.turnCount = 10;
    sm.rotate(session);
    expect(session.claudeSessionId).toBeNull();
    expect(session.turnCount).toBe(0);
  });

  it("flush writes sessions to disk atomically", () => {
    sm.getOrCreate("cli", "local", "assistant");
    sm.flush();
    const filePath = path.join(tempDir, "sessions.json");
    expect(existsSync(filePath)).toBe(true);
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(data.version).toBe(1);
    expect(data.sessions["cli:local:assistant"]).toBeDefined();
  });

  it("loads sessions from disk on construction", () => {
    sm.getOrCreate("cli", "local", "assistant");
    sm.update("cli:local:assistant", { claudeSessionId: "persisted-id" });
    sm.flush();

    // Create new manager from same dir
    const sm2 = new SessionManager(makeConfig(tempDir));
    const session = sm2.get("cli:local:assistant");
    expect(session?.claudeSessionId).toBe("persisted-id");
  });

  it("listAll returns all sessions", () => {
    sm.getOrCreate("cli", "local", "agent1");
    sm.getOrCreate("web", "user2", "agent1");
    expect(sm.listAll()).toHaveLength(2);
  });

  it("count returns correct count", () => {
    expect(sm.count()).toBe(0);
    sm.getOrCreate("cli", "local", "assistant");
    expect(sm.count()).toBe(1);
    sm.getOrCreate("web", "user2", "assistant");
    expect(sm.count()).toBe(2);
  });

  it("gc removes expired sessions", () => {
    const session = sm.getOrCreate("cli", "local", "assistant");
    // Set lastActiveAt to 60 days ago
    const old = new Date();
    old.setDate(old.getDate() - 60);
    session.lastActiveAt = old.toISOString();
    const removed = sm.gc();
    expect(removed).toBe(1);
    expect(sm.count()).toBe(0);
  });

  it("gc preserves active sessions", () => {
    sm.getOrCreate("cli", "local", "assistant");
    const removed = sm.gc();
    expect(removed).toBe(0);
    expect(sm.count()).toBe(1);
  });
});
