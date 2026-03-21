// Layer 0: Config — depends only on types.ts
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { ChannelSecurityProfile } from "./types.js";
import { ConfigError } from "./types.js";

export interface MiclawConfig {
  defaultAgent: string;
  defaultModel: string;
  soulDir: string;
  skillsDir: string;
  memoryDir: string;
  sessionsDir: string;
  journalDays: number;
  promptMode: "append" | "replace";
  mcpConfig: string | null;
  permissionMode: string;
  maxConcurrentProcesses: number;
  maxQueueDepth: number;
  maxTurnsPerSession: number;
  sessionTtlDays: number;
  channels: {
    cli: {
      enabled: boolean;
      prompt?: string;
      security?: Partial<ChannelSecurityProfile>;
    };
    web: {
      enabled: boolean;
      port: number;
      host?: string;
      corsOrigins?: string[];
      staticDir?: string;
      auth: {
        type: "none" | "api-key";
        apiKey?: string;
      };
      security?: Partial<ChannelSecurityProfile>;
    };
  };
  cron: {
    enabled: boolean;
    jobsFile: string;
    timezone?: string;
  };
  learning: {
    enabled: boolean;
    model: string;
    afterEveryTurn: boolean;
    consolidationCron: string;
    maxLearningEntries: number;
  };
}

const DEFAULTS: MiclawConfig = {
  defaultAgent: "assistant",
  defaultModel: "sonnet",
  soulDir: "./soul",
  skillsDir: "./skills",
  memoryDir: "./memory",
  sessionsDir: "./sessions",
  journalDays: 3,
  promptMode: "append",
  mcpConfig: null,
  permissionMode: "default",
  maxConcurrentProcesses: 5,
  maxQueueDepth: 20,
  maxTurnsPerSession: 20,
  sessionTtlDays: 30,
  channels: {
    cli: { enabled: true, prompt: "you> " },
    web: {
      enabled: true,
      port: 3456,
      host: "127.0.0.1",
      auth: { type: "none" },
    },
  },
  cron: {
    enabled: true,
    jobsFile: "./cron/jobs.json",
  },
  learning: {
    enabled: true,
    model: "haiku",
    afterEveryTurn: false,
    consolidationCron: "0 2 * * *",
    maxLearningEntries: 200,
  },
};

/** Resolve env var references like "${MICLAW_WEB_API_KEY}". Warns on missing vars. */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, envKey) => {
    const resolved = process.env[envKey];
    if (resolved === undefined) {
      console.warn(`[config] Warning: environment variable ${envKey} is not set`);
      return "";
    }
    return resolved;
  });
}

/** Deep merge b into a (b wins) */
function deepMerge(a: any, b: any): any {
  const result = { ...a };
  for (const key of Object.keys(b)) {
    if (b[key] && typeof b[key] === "object" && !Array.isArray(b[key]) && a[key] && typeof a[key] === "object") {
      result[key] = deepMerge(a[key], b[key]);
    } else {
      result[key] = b[key];
    }
  }
  return result;
}

let _projectRoot: string = process.cwd();

export function getProjectRoot(): string {
  return _projectRoot;
}

export function loadConfig(configPath?: string): MiclawConfig {
  const filePath = configPath ?? path.join(process.cwd(), "miclaw.json");
  _projectRoot = path.dirname(path.resolve(filePath));

  let userConfig: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      userConfig = JSON.parse(raw);
    } catch (e) {
      throw new ConfigError(`Failed to parse ${filePath}: ${e}`);
    }
  }

  const config = deepMerge(DEFAULTS, userConfig) as MiclawConfig;

  // Resolve env var references in auth apiKey
  if (config.channels.web.auth.apiKey) {
    config.channels.web.auth.apiKey = resolveEnvVars(config.channels.web.auth.apiKey);
  }

  return config;
}

/** Resolve a config-relative path to an absolute path */
export function resolvePath(configRelative: string): string {
  if (path.isAbsolute(configRelative)) return configRelative;
  return path.resolve(_projectRoot, configRelative);
}

/** Default security profiles per channel */
export function getSecurityProfile(channelName: string, config: MiclawConfig): ChannelSecurityProfile {
  const defaults: Record<string, ChannelSecurityProfile> = {
    cli: {
      // CLI: local user, full trust — no tool restrictions
      allowedTools: [],
      permissionMode: config.permissionMode,
      maxMessageLength: 200_000,
      maxTimeoutMs: 300_000,
      requireAuth: false,
      learningEnabled: config.learning.enabled,
      agentWriteToMemoryEnabled: true,
      // Security: permissive defaults for local user
      allowedPaths: [],      // [] = project root only
      blockedPaths: [],      // [] = use default sensitive dirs (~/.ssh, ~/.aws, etc.)
      writeBlockedPaths: [], // [] = no write-specific blocks (CLI user has full trust)
      allowedUrls: [],       // [] = allow all URLs
      blockedUrls: [],
      maxCostPerRequest: 0,  // 0 = unlimited
      rateLimitPerMinute: 0, // 0 = unlimited (local user)
      auditEnabled: true,
    },
    web: {
      // Web: allowlist is the security gate (read-only tools only)
      // Permission mode must be permissive so whitelisted tools can execute in -p mode
      allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
      permissionMode: "bypassPermissions",
      maxMessageLength: 50_000,
      maxTimeoutMs: 120_000,
      requireAuth: config.channels.web.auth.type !== "none",
      learningEnabled: config.learning.enabled,
      agentWriteToMemoryEnabled: false,
      // Security: restrictive defaults for external users
      allowedPaths: [],       // [] = project root only
      blockedPaths: [],       // [] = use default sensitive dirs
      writeBlockedPaths: [],  // [] = no write-specific blocks (web has no Write/Edit tools anyway)
      allowedUrls: [],        // [] = allow all URLs
      blockedUrls: [],
      maxCostPerRequest: 0,   // 0 = unlimited (configure per deployment)
      rateLimitPerMinute: 60, // 60 req/min per user
      auditEnabled: true,
    },
    cron: {
      // Cron: system-generated messages, full trust
      allowedTools: [],
      permissionMode: "bypassPermissions",
      maxMessageLength: 200_000,
      maxTimeoutMs: 600_000,
      requireAuth: false,
      learningEnabled: false,
      agentWriteToMemoryEnabled: true,
      // Security: permissive for system jobs, but protect trusted memory files
      allowedPaths: [],       // [] = project root only
      blockedPaths: [],       // [] = use default sensitive dirs
      writeBlockedPaths: ["memory/MEMORY.md", "memory/learnings-validated.md"],
      allowedUrls: [],
      blockedUrls: [],
      maxCostPerRequest: 0,
      rateLimitPerMinute: 0,  // unlimited (system)
      auditEnabled: true,
    },
  };

  const base = defaults[channelName] ?? defaults.cli;
  const overrides = (config.channels as any)[channelName]?.security;
  return overrides ? { ...base, ...overrides } : base;
}
