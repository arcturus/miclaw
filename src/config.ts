// Layer 0: Config — depends only on types.ts
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { ChannelSecurityProfile } from "./types.js";
import { ConfigError } from "./types.js";

export interface MikeClawConfig {
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

const DEFAULTS: MikeClawConfig = {
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

/** Resolve env var references like "${MIKECLAW_WEB_API_KEY}". Warns on missing vars. */
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

export function loadConfig(configPath?: string): MikeClawConfig {
  const filePath = configPath ?? path.join(process.cwd(), "mikeclaw.json");
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

  const config = deepMerge(DEFAULTS, userConfig) as MikeClawConfig;

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
export function getSecurityProfile(channelName: string, config: MikeClawConfig): ChannelSecurityProfile {
  const defaults: Record<string, ChannelSecurityProfile> = {
    cli: {
      allowedTools: [],
      permissionMode: config.permissionMode,
      maxMessageLength: 200_000,
      maxTimeoutMs: 300_000,
      requireAuth: false,
      learningEnabled: config.learning.enabled,
      agentWriteToMemoryEnabled: true,
    },
    web: {
      allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
      permissionMode: "plan",
      maxMessageLength: 50_000,
      maxTimeoutMs: 120_000,
      requireAuth: config.channels.web.auth.type !== "none",
      learningEnabled: config.learning.enabled,
      agentWriteToMemoryEnabled: false,
    },
    cron: {
      allowedTools: [],
      permissionMode: config.permissionMode,
      maxMessageLength: 200_000,
      maxTimeoutMs: 600_000,
      requireAuth: false,
      learningEnabled: false,
      agentWriteToMemoryEnabled: true,
    },
  };

  const base = defaults[channelName] ?? defaults.cli;
  const overrides = (config.channels as any)[channelName]?.security;
  return overrides ? { ...base, ...overrides } : base;
}
