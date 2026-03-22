import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  PathEnforcer,
  UrlEnforcer,
  RateLimiter,
  AuditLogger,
  extractPathsFromToolInput,
  extractUrlsFromToolInput,
  checkStreamLine,
  DEFAULT_BLOCKED_PATHS,
} from "../src/security.js";

// ─── PathEnforcer ─────────────────────────────────────────────

describe("PathEnforcer", () => {
  const projectRoot = "/home/user/project";

  it("allows paths within project root (default allowedPaths)", () => {
    const enforcer = new PathEnforcer([], [], projectRoot);
    expect(enforcer.check("/home/user/project/src/index.ts")).toBeNull();
    expect(enforcer.check("/home/user/project/package.json")).toBeNull();
  });

  it("allows the project root itself", () => {
    const enforcer = new PathEnforcer([], [], projectRoot);
    expect(enforcer.check("/home/user/project")).toBeNull();
  });

  it("blocks paths outside project root", () => {
    const enforcer = new PathEnforcer([], [], projectRoot);
    expect(enforcer.check("/home/user/other-project/file.ts")).not.toBeNull();
    expect(enforcer.check("/etc/passwd")).not.toBeNull();
  });

  it("blocks default sensitive directories", () => {
    const home = os.homedir();
    const enforcer = new PathEnforcer([], [], projectRoot);
    expect(enforcer.check(path.join(home, ".ssh/id_rsa"))).not.toBeNull();
    expect(enforcer.check(path.join(home, ".aws/credentials"))).not.toBeNull();
    expect(enforcer.check(path.join(home, ".gnupg/private-keys"))).not.toBeNull();
    expect(enforcer.check(path.join(home, ".config/some-app"))).not.toBeNull();
    expect(enforcer.check("/etc/shadow")).not.toBeNull();
  });

  it("uses explicit allowedPaths instead of project root when provided", () => {
    const enforcer = new PathEnforcer(["/data/shared", "/tmp/work"], [], projectRoot);
    expect(enforcer.check("/data/shared/file.txt")).toBeNull();
    expect(enforcer.check("/tmp/work/output.json")).toBeNull();
    expect(enforcer.check("/home/user/project/src/index.ts")).not.toBeNull();
  });

  it("uses explicit blockedPaths instead of defaults when provided", () => {
    const enforcer = new PathEnforcer([], ["/home/user/project/secrets"], projectRoot);
    expect(enforcer.check("/home/user/project/secrets/key.pem")).not.toBeNull();
    // Default blocked paths are NOT applied when explicit ones are provided
    const home = os.homedir();
    // But project root still applies, so .ssh is outside project root
    expect(enforcer.check(path.join(home, ".ssh/id_rsa"))).not.toBeNull();
  });

  it("blockedPaths takes priority over allowedPaths", () => {
    const enforcer = new PathEnforcer(
      ["/home/user/project"],
      ["/home/user/project/secrets"],
      projectRoot,
    );
    expect(enforcer.check("/home/user/project/src/index.ts")).toBeNull();
    expect(enforcer.check("/home/user/project/secrets/api-key.txt")).not.toBeNull();
  });

  it("resolves relative paths against project root", () => {
    const enforcer = new PathEnforcer(["./"], [], projectRoot);
    expect(enforcer.check("/home/user/project/src/file.ts")).toBeNull();
  });

  it("handles tilde paths", () => {
    const enforcer = new PathEnforcer(["~/documents"], [], projectRoot);
    const home = os.homedir();
    expect(enforcer.check(path.join(home, "documents/notes.txt"))).toBeNull();
  });

  it("prevents path traversal", () => {
    const enforcer = new PathEnforcer([], [], projectRoot);
    expect(enforcer.check("/home/user/project/../../etc/shadow")).not.toBeNull();
  });

  it("does not match partial directory names", () => {
    const enforcer = new PathEnforcer([], [], "/home/user/pro");
    // "/home/user/project" should NOT match allowed path "/home/user/pro"
    expect(enforcer.check("/home/user/project/file.ts")).not.toBeNull();
  });
});

// ─── UrlEnforcer ──────────────────────────────────────────────

describe("UrlEnforcer", () => {
  it("allows all URLs when both lists are empty", () => {
    const enforcer = new UrlEnforcer([], []);
    expect(enforcer.check("https://example.com/api")).toBeNull();
    expect(enforcer.check("https://any-site.org/page")).toBeNull();
  });

  it("blocks URLs matching blockedUrls", () => {
    const enforcer = new UrlEnforcer([], ["evil.com", "*.malware.net"]);
    expect(enforcer.check("https://evil.com/steal")).not.toBeNull();
    expect(enforcer.check("https://sub.malware.net/payload")).not.toBeNull();
  });

  it("allows URLs matching allowedUrls", () => {
    const enforcer = new UrlEnforcer(["api.github.com", "*.example.com"], []);
    expect(enforcer.check("https://api.github.com/repos")).toBeNull();
    expect(enforcer.check("https://sub.example.com/data")).toBeNull();
    expect(enforcer.check("https://example.com/data")).toBeNull();
  });

  it("blocks URLs not in allowedUrls when allowedUrls is set", () => {
    const enforcer = new UrlEnforcer(["api.github.com"], []);
    expect(enforcer.check("https://other-api.com/data")).not.toBeNull();
  });

  it("blockedUrls takes priority over allowedUrls", () => {
    const enforcer = new UrlEnforcer(["*.example.com"], ["evil.example.com"]);
    expect(enforcer.check("https://good.example.com")).toBeNull();
    expect(enforcer.check("https://evil.example.com")).not.toBeNull();
  });

  it("rejects malformed URLs", () => {
    const enforcer = new UrlEnforcer([], []);
    expect(enforcer.check("not-a-url")).not.toBeNull();
  });

  it("wildcard matches subdomain but also exact domain", () => {
    const enforcer = new UrlEnforcer(["*.github.com"], []);
    expect(enforcer.check("https://api.github.com/repos")).toBeNull();
    expect(enforcer.check("https://github.com/repos")).toBeNull();
    expect(enforcer.check("https://deep.sub.github.com/repos")).toBeNull();
  });
});

// ─── RateLimiter ──────────────────────────────────────────────

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it("allows requests under the limit", () => {
    expect(limiter.check("user-1", 5)).toBe(true);
    expect(limiter.check("user-1", 5)).toBe(true);
    expect(limiter.check("user-1", 5)).toBe(true);
  });

  it("blocks requests over the limit", () => {
    for (let i = 0; i < 3; i++) {
      limiter.check("user-1", 3);
    }
    expect(limiter.check("user-1", 3)).toBe(false);
  });

  it("tracks users independently", () => {
    for (let i = 0; i < 3; i++) {
      limiter.check("user-1", 3);
    }
    expect(limiter.check("user-1", 3)).toBe(false);
    expect(limiter.check("user-2", 3)).toBe(true);
  });

  it("returns true for maxPerMinute 0 (unlimited)", () => {
    for (let i = 0; i < 100; i++) {
      expect(limiter.check("user-1", 0)).toBe(true);
    }
  });

  it("allows requests after window expires", () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 3; i++) {
        limiter.check("user-1", 3);
      }
      expect(limiter.check("user-1", 3)).toBe(false);

      // Advance past the 60-second window
      vi.advanceTimersByTime(61_000);
      expect(limiter.check("user-1", 3)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reset() clears all state", () => {
    for (let i = 0; i < 3; i++) {
      limiter.check("user-1", 3);
    }
    expect(limiter.check("user-1", 3)).toBe(false);
    limiter.reset();
    expect(limiter.check("user-1", 3)).toBe(true);
  });
});

// ─── AuditLogger ──────────────────────────────────────────────

describe("AuditLogger", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "miclaw-audit-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes JSONL entries to the log file", () => {
    const logPath = path.join(tempDir, "audit.jsonl");
    const logger = new AuditLogger(logPath);

    logger.log({
      timestamp: "2026-01-01T00:00:00Z",
      channelId: "web",
      userId: "user-1",
      agentId: "assistant",
      action: "tool_use",
      tool: "Read",
      detail: { file_path: "/some/file" },
    });

    logger.log({
      timestamp: "2026-01-01T00:00:01Z",
      channelId: "web",
      userId: "user-1",
      agentId: "assistant",
      action: "request_end",
    });

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).action).toBe("tool_use");
    expect(JSON.parse(lines[1]).action).toBe("request_end");
  });

  it("creates parent directory if missing", () => {
    const logPath = path.join(tempDir, "nested", "dir", "audit.jsonl");
    const logger = new AuditLogger(logPath);

    logger.log({
      timestamp: "2026-01-01T00:00:00Z",
      channelId: "cli",
      userId: "local",
      agentId: "assistant",
      action: "request_start",
    });

    const content = readFileSync(logPath, "utf-8");
    expect(JSON.parse(content.trim()).channelId).toBe("cli");
  });
});

// ─── extractPathsFromToolInput ────────────────────────────────

describe("extractPathsFromToolInput", () => {
  it("extracts file_path from Read", () => {
    expect(extractPathsFromToolInput("Read", { file_path: "/home/user/file.ts" }))
      .toEqual(["/home/user/file.ts"]);
  });

  it("extracts file_path from Write", () => {
    expect(extractPathsFromToolInput("Write", { file_path: "/tmp/out.txt", content: "hello" }))
      .toEqual(["/tmp/out.txt"]);
  });

  it("extracts file_path from Edit", () => {
    expect(extractPathsFromToolInput("Edit", { file_path: "/src/app.ts", old_string: "a", new_string: "b" }))
      .toEqual(["/src/app.ts"]);
  });

  it("extracts path from Glob", () => {
    expect(extractPathsFromToolInput("Glob", { pattern: "**/*.ts", path: "/home/user/project" }))
      .toEqual(["/home/user/project"]);
  });

  it("extracts path from Grep", () => {
    expect(extractPathsFromToolInput("Grep", { pattern: "TODO", path: "/src" }))
      .toEqual(["/src"]);
  });

  it("returns empty array for unknown tools", () => {
    expect(extractPathsFromToolInput("Bash", { command: "ls /etc" })).toEqual([]);
  });

  it("returns empty array when field is missing", () => {
    expect(extractPathsFromToolInput("Read", {})).toEqual([]);
  });

  it("returns empty array when field is not a string", () => {
    expect(extractPathsFromToolInput("Read", { file_path: 42 })).toEqual([]);
  });
});

// ─── extractUrlsFromToolInput ─────────────────────────────────

describe("extractUrlsFromToolInput", () => {
  it("extracts url from WebFetch", () => {
    expect(extractUrlsFromToolInput("WebFetch", { url: "https://example.com/api" }))
      .toEqual(["https://example.com/api"]);
  });

  it("extracts URLs from WebSearch query", () => {
    const urls = extractUrlsFromToolInput("WebSearch", { query: "check https://evil.com/leak for data" });
    expect(urls).toEqual(["https://evil.com/leak"]);
  });

  it("returns empty for non-URL tools", () => {
    expect(extractUrlsFromToolInput("Read", { file_path: "/file" })).toEqual([]);
  });

  it("returns empty when query has no URLs", () => {
    expect(extractUrlsFromToolInput("WebSearch", { query: "how to use TypeScript" })).toEqual([]);
  });
});

// ─── checkStreamLine ──────────────────────────────────────────

describe("checkStreamLine", () => {
  const ctx = { channelId: "web", userId: "user-1", agentId: "assistant" };
  const projectRoot = "/home/user/project";

  it("returns null for non-assistant events", () => {
    const line = JSON.stringify({ type: "system", session_id: "abc" });
    const enforcer = new PathEnforcer([], [], projectRoot);
    expect(checkStreamLine(line, enforcer, null, null, ctx)).toBeNull();
  });

  it("returns null for assistant text blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello" }] },
    });
    const enforcer = new PathEnforcer([], [], projectRoot);
    expect(checkStreamLine(line, enforcer, null, null, ctx)).toBeNull();
  });

  it("returns null for tool_use with allowed path", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "Read",
          input: { file_path: "/home/user/project/src/index.ts" },
        }],
      },
    });
    const enforcer = new PathEnforcer([], [], projectRoot);
    expect(checkStreamLine(line, enforcer, null, null, ctx)).toBeNull();
  });

  it("returns violation for tool_use with blocked path", () => {
    const home = os.homedir();
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "Read",
          input: { file_path: path.join(home, ".ssh/id_rsa") },
        }],
      },
    });
    const enforcer = new PathEnforcer([], [], projectRoot);
    const result = checkStreamLine(line, enforcer, null, null, ctx);
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
  });

  it("returns violation for tool_use with path outside project root", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "Read",
          input: { file_path: "/etc/passwd" },
        }],
      },
    });
    const enforcer = new PathEnforcer([], [], projectRoot);
    const result = checkStreamLine(line, enforcer, null, null, ctx);
    expect(result).not.toBeNull();
    expect(result).toContain("not allowed");
  });

  it("returns violation for blocked URL", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "WebFetch",
          input: { url: "https://evil.com/steal-data" },
        }],
      },
    });
    const urlEnforcer = new UrlEnforcer(["api.github.com"], []);
    expect(checkStreamLine(line, null, urlEnforcer, null, ctx)).not.toBeNull();
  });

  it("returns null for malformed JSON lines", () => {
    expect(checkStreamLine("not json", null, null, null, ctx)).toBeNull();
  });

  it("returns null when no enforcers are provided", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "Read",
          input: { file_path: "/etc/shadow" },
        }],
      },
    });
    expect(checkStreamLine(line, null, null, null, ctx)).toBeNull();
  });

  it("logs tool_use to audit logger", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "miclaw-audit-"));
    const logPath = path.join(tempDir, "audit.jsonl");
    const logger = new AuditLogger(logPath);

    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "Read",
          input: { file_path: "/home/user/project/file.ts" },
        }],
      },
    });

    const enforcer = new PathEnforcer([], [], projectRoot);
    checkStreamLine(line, enforcer, null, logger, ctx);

    const entries = readFileSync(logPath, "utf-8").trim().split("\n").map((line: string) => JSON.parse(line));
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("tool_use");
    expect(entries[0].tool).toBe("Read");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("logs violation to audit logger when path is blocked", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "miclaw-audit-"));
    const logPath = path.join(tempDir, "audit.jsonl");
    const logger = new AuditLogger(logPath);
    const home = os.homedir();

    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "Read",
          input: { file_path: path.join(home, ".ssh/id_rsa") },
        }],
      },
    });

    const enforcer = new PathEnforcer([], [], projectRoot);
    checkStreamLine(line, enforcer, null, logger, ctx);

    const entries = readFileSync(logPath, "utf-8").trim().split("\n").map((line: string) => JSON.parse(line));
    // Should have both tool_use and violation entries
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe("tool_use");
    expect(entries[1].action).toBe("violation");

    rmSync(tempDir, { recursive: true, force: true });
  });
});
