// Layer 1: Security — path enforcement, URL filtering, rate limiting, audit logging
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AuditEntry } from "./types.js";

// ─── Default Blocked Paths ────────────────────────────────────

const HOME = os.homedir();

/** Sensitive directories blocked by default when no explicit blockedPaths are configured */
export const DEFAULT_BLOCKED_PATHS = [
  path.join(HOME, ".ssh"),
  path.join(HOME, ".aws"),
  path.join(HOME, ".gnupg"),
  path.join(HOME, ".config"),
  "/etc/shadow",
];

// ─── Path Enforcer ────────────────────────────────────────────

/**
 * Enforces file path restrictions for LLM tool calls.
 *
 * Resolution order:
 * 1. blockedPaths are checked first (deny wins)
 * 2. allowedPaths are checked second (must match at least one)
 *
 * Both lists contain absolute paths. A target path matches if it
 * starts with (i.e. is inside) any entry in the list.
 */
export class PathEnforcer {
  private allowed: string[];
  private blocked: string[];

  constructor(allowedPaths: string[], blockedPaths: string[], private projectRoot: string) {
    // Resolve configured paths relative to project root
    this.allowed = allowedPaths.length > 0
      ? allowedPaths.map((p) => this.resolve(p))
      : [projectRoot];

    // Use defaults if no explicit blocked paths
    this.blocked = blockedPaths.length > 0
      ? blockedPaths.map((p) => this.resolve(p))
      : DEFAULT_BLOCKED_PATHS;
  }

  /**
   * Check if a target path is allowed.
   * @returns null if allowed, or a violation reason string if blocked.
   */
  check(targetPath: string): string | null {
    const resolved = this.resolve(targetPath);

    // Blocked paths take priority
    for (const blocked of this.blocked) {
      if (resolved === blocked || resolved.startsWith(blocked + path.sep)) {
        return `Path blocked: ${targetPath} (matches blocked path ${blocked})`;
      }
    }

    // Must match at least one allowed path
    for (const allowed of this.allowed) {
      if (resolved === allowed || resolved.startsWith(allowed + path.sep)) {
        return null;
      }
    }

    return `Path not allowed: ${targetPath} (not within allowed paths)`;
  }

  private resolve(p: string): string {
    if (p.startsWith("~")) {
      p = path.join(HOME, p.slice(1));
    }
    return path.isAbsolute(p) ? path.resolve(p) : path.resolve(this.projectRoot, p);
  }
}

// ─── URL Enforcer ─────────────────────────────────────────────

/**
 * Enforces URL restrictions for WebFetch/WebSearch tool calls.
 *
 * Supports simple wildcard matching on hostnames:
 * - "*.example.com" matches "api.example.com", "sub.api.example.com"
 * - "example.com" matches only "example.com" exactly
 *
 * Resolution order:
 * 1. blockedUrls checked first (deny wins)
 * 2. If allowedUrls is non-empty, URL must match at least one
 * 3. If allowedUrls is empty, all non-blocked URLs are allowed
 */
export class UrlEnforcer {
  constructor(
    private allowedUrls: string[],
    private blockedUrls: string[],
  ) {}

  /**
   * Check if a URL is allowed.
   * @returns null if allowed, or a violation reason string if blocked.
   */
  check(url: string): string | null {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return `Malformed URL: ${url}`;
    }

    // Blocked URLs take priority
    for (const pattern of this.blockedUrls) {
      if (this.matchHostname(hostname, pattern)) {
        return `URL blocked: ${url} (matches blocked pattern ${pattern})`;
      }
    }

    // If allow list is set, must match
    if (this.allowedUrls.length > 0) {
      for (const pattern of this.allowedUrls) {
        if (this.matchHostname(hostname, pattern)) {
          return null;
        }
      }
      return `URL not allowed: ${url} (not in allowed URL list)`;
    }

    return null;
  }

  private matchHostname(hostname: string, pattern: string): boolean {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2);
      return hostname === suffix || hostname.endsWith("." + suffix);
    }
    return hostname === pattern;
  }
}

// ─── Rate Limiter ─────────────────────────────────────────────

/**
 * Sliding-window rate limiter per userId.
 * Tracks request timestamps in a 60-second window.
 */
export class RateLimiter {
  private windows: Map<string, number[]> = new Map();

  /**
   * Check if a request is allowed under the rate limit.
   * @param userId - The user making the request
   * @param maxPerMinute - Max requests per minute. 0 = unlimited.
   * @returns true if allowed, false if rate-limited
   */
  check(userId: string, maxPerMinute: number): boolean {
    if (maxPerMinute <= 0) return true;

    const now = Date.now();
    const windowStart = now - 60_000;

    let timestamps = this.windows.get(userId) ?? [];
    // Prune entries outside the window
    timestamps = timestamps.filter((t) => t > windowStart);

    if (timestamps.length >= maxPerMinute) {
      this.windows.set(userId, timestamps);
      return false;
    }

    timestamps.push(now);
    this.windows.set(userId, timestamps);
    return true;
  }

  /** Clear all rate limit state (for testing) */
  reset(): void {
    this.windows.clear();
  }
}

// ─── Audit Logger ─────────────────────────────────────────────

/**
 * Append-only audit logger that writes JSONL entries to a file.
 * Each line is a self-contained JSON object representing one event.
 */
export class AuditLogger {
  private dirCreated = false;

  constructor(private logPath: string) {}

  log(entry: AuditEntry): void {
    if (!this.dirCreated) {
      const dir = path.dirname(this.logPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.dirCreated = true;
    }

    const line = JSON.stringify(entry) + "\n";
    try {
      appendFileSync(this.logPath, line);
    } catch (err) {
      console.warn(`[audit] Failed to write audit log: ${err}`);
    }
  }
}

// ─── Tool Input Extraction ────────────────────────────────────

/** Known tools that operate on file paths */
const PATH_TOOLS: Record<string, string[]> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  Glob: ["path"],
  Grep: ["path"],
};

/** Known tools that operate on URLs */
const URL_TOOLS: Record<string, string[]> = {
  WebFetch: ["url"],
  WebSearch: ["query"],   // best-effort: query may contain URLs
};

/**
 * Extract file paths from a tool_use input object.
 * Returns an array of path strings found in known fields.
 */
export function extractPathsFromToolInput(toolName: string, input: Record<string, unknown>): string[] {
  const fields = PATH_TOOLS[toolName];
  if (!fields) return [];

  const paths: string[] = [];
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "string" && value.length > 0) {
      paths.push(value);
    }
  }
  return paths;
}

/**
 * Extract URLs from a tool_use input object.
 * Returns an array of URL strings found in known fields.
 */
export function extractUrlsFromToolInput(toolName: string, input: Record<string, unknown>): string[] {
  const fields = URL_TOOLS[toolName];
  if (!fields) return [];

  const urls: string[] = [];
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "string" && value.length > 0) {
      // For WebFetch, the value is a URL directly
      // For WebSearch, try to extract URLs from the query string
      if (field === "url") {
        urls.push(value);
      } else if (field === "query") {
        const urlMatches = value.match(/https?:\/\/[^\s"'<>]+/g);
        if (urlMatches) urls.push(...urlMatches);
      }
    }
  }
  return urls;
}

/**
 * Check a single NDJSON line from the Claude stream for security violations.
 *
 * @returns A violation description string if a violation is found, or null if the line is safe.
 */
export function checkStreamLine(
  line: string,
  pathEnforcer: PathEnforcer | null,
  urlEnforcer: UrlEnforcer | null,
  auditLogger: AuditLogger | null,
  context: { channelId: string; userId: string; agentId: string },
): string | null {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return null; // Skip malformed lines
  }

  // Only check assistant events with tool_use content blocks
  if (event.type !== "assistant" || !event.message?.content) {
    return null;
  }

  const content = event.message.content;
  if (!Array.isArray(content)) return null;

  for (const block of content) {
    if (block.type !== "tool_use") continue;

    const toolName = block.name ?? "unknown";
    const input = (block.input ?? {}) as Record<string, unknown>;

    // Audit log every tool use
    auditLogger?.log({
      timestamp: new Date().toISOString(),
      channelId: context.channelId,
      userId: context.userId,
      agentId: context.agentId,
      action: "tool_use",
      tool: toolName,
      detail: { input_preview: JSON.stringify(input).slice(0, 200) },
    });

    // Check paths
    if (pathEnforcer) {
      const paths = extractPathsFromToolInput(toolName, input);
      for (const p of paths) {
        const violation = pathEnforcer.check(p);
        if (violation) {
          auditLogger?.log({
            timestamp: new Date().toISOString(),
            channelId: context.channelId,
            userId: context.userId,
            agentId: context.agentId,
            action: "violation",
            tool: toolName,
            detail: { path: p, reason: violation },
          });
          return violation;
        }
      }
    }

    // Check URLs
    if (urlEnforcer) {
      const urls = extractUrlsFromToolInput(toolName, input);
      for (const url of urls) {
        const violation = urlEnforcer.check(url);
        if (violation) {
          auditLogger?.log({
            timestamp: new Date().toISOString(),
            channelId: context.channelId,
            userId: context.userId,
            agentId: context.agentId,
            action: "violation",
            tool: toolName,
            detail: { url, reason: violation },
          });
          return violation;
        }
      }
    }
  }

  return null;
}
