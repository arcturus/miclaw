// Layer 0: Types — no internal imports

// ─── Channel ───────────────────────────────────────────────

export type MessageHandler = (input: MessageInput) => Promise<MessageOutput>;

export interface Channel {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: MessageHandler): void;
  send(userId: string, message: string): Promise<boolean>;
}

export interface MessageInput {
  channelId: string;
  userId: string;
  message: string;
  agentId?: string;
  ephemeral?: boolean;
  metadata?: Record<string, unknown>;
}

export interface MessageOutput {
  result: string;
  sessionId: string;
  cost?: number;
  durationMs: number;
}

// ─── Claude Runner ─────────────────────────────────────────

export interface ClaudeRunnerOptions {
  message: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  resume?: string;
  model?: string;
  allowedTools?: string[];
  mcpConfig?: string;
  timeoutMs?: number;
  cwd?: string;
  permissionMode?: string;
  /** Security profile for real-time enforcement during streaming */
  securityProfile?: ChannelSecurityProfile;
  /** Context for audit logging */
  securityContext?: { channelId: string; userId: string; agentId: string };
}

export interface ClaudeRunnerResult {
  result: string;
  sessionId: string;
  ok: boolean;
  error?: string;
  cost?: number;
  rawOutput?: ClaudeJsonOutput;
  durationMs: number;
}

export interface ClaudeJsonOutput {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution";
  is_error: boolean;
  result: string;
  session_id: string;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
}

// ─── Session ───────────────────────────────────────────────

export interface Session {
  id: string;
  agentId: string;
  channelId: string;
  userId: string;
  claudeSessionId: string | null;
  createdAt: string;
  lastActiveAt: string;
  turnCount: number;
  metadata: Record<string, unknown>;
}

export interface SessionStore {
  sessions: Record<string, Session>;
  version: number;
}

// ─── Cron ──────────────────────────────────────────────────

export interface BroadcastTarget {
  channel: string;
  userId: string;
}

export interface CronJob {
  id: string;
  schedule: string;
  agent: string;
  message: string;
  enabled: boolean;
  outputMode: "silent" | "journal" | "broadcast";
  broadcastTarget?: BroadcastTarget;
  model?: string;
  timeoutMs?: number;
  timezone?: string;
  allowedTools?: string[];
  permissionMode?: string;
}

export interface CronExecution {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: "success" | "error";
  outputMode: CronJob["outputMode"];
  resultPreview: string;
  error?: string;
}

// ─── Skills ────────────────────────────────────────────────

export interface SkillDefinition {
  name: string;
  description: string;
  allowedTools: string[];
  requires?: {
    bins?: string[];
    env?: string[];
    os?: Array<"linux" | "darwin" | "win32">;
  };
  body: string;
  filePath: string;
}

// ─── Agents ────────────────────────────────────────────────

export interface AgentConfig {
  id: string;
  description: string;
  soulDir: string;
  skills: string[];
  model?: string;
  allowedTools?: string[];
  mcpConfig?: string;
  permissionMode?: string;
}

// ─── Security ──────────────────────────────────────────────

export interface ChannelSecurityProfile {
  allowedTools: string[];
  permissionMode: string;
  maxMessageLength: number;
  maxTimeoutMs: number;
  requireAuth: boolean;
  learningEnabled: boolean;
  agentWriteToMemoryEnabled: boolean;

  /**
   * Directories the LLM may access for file operations (Read, Write, Edit, Glob, Grep).
   * Paths are resolved relative to the project root.
   * Empty array = project root directory only.
   */
  allowedPaths: string[];

  /**
   * Directories the LLM must never access, even if a parent is in allowedPaths.
   * Takes priority over allowedPaths. Paths resolved relative to project root.
   * Empty array = use default blocked paths (~/.ssh, ~/.aws, ~/.gnupg, ~/.config).
   */
  blockedPaths: string[];

  /**
   * URL hostname patterns allowed for WebFetch/WebSearch.
   * Supports simple wildcards: "*.example.com", "api.github.com".
   * Empty array = allow all URLs.
   */
  allowedUrls: string[];

  /**
   * URL hostname patterns blocked for WebFetch/WebSearch.
   * Checked before allowedUrls. Supports same wildcard syntax.
   * Empty array = block nothing.
   */
  blockedUrls: string[];

  /**
   * Maximum cost in USD per single request. Process is terminated if exceeded.
   * Note: cost is only known when the process completes, so enforcement is post-hoc.
   * 0 = unlimited.
   */
  maxCostPerRequest: number;

  /**
   * Maximum requests per minute per userId. 0 = unlimited.
   * Only meaningful for channels with external users (web).
   */
  rateLimitPerMinute: number;

  /** Enable audit logging for this channel. */
  auditEnabled: boolean;
}

export interface AuditEntry {
  timestamp: string;
  channelId: string;
  userId: string;
  agentId: string;
  action: "tool_use" | "violation" | "request_start" | "request_end";
  tool?: string;
  detail?: Record<string, unknown>;
}

// ─── Errors ────────────────────────────────────────────────

export class MiclawError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "MiclawError";
  }
}

export class RunnerError extends MiclawError {
  constructor(message: string, code: "RUNNER_TIMEOUT" | "RUNNER_EXIT" | "RUNNER_PARSE" | "RUNNER_SPAWN") {
    super(message, code);
    this.name = "RunnerError";
  }
}

export class SessionError extends MiclawError {
  constructor(message: string, code: "SESSION_CORRUPT" | "SESSION_EXPIRED" | "SESSION_LOCKED") {
    super(message, code);
    this.name = "SessionError";
  }
}

export class ConfigError extends MiclawError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR");
    this.name = "ConfigError";
  }
}

export class ValidationError extends MiclawError {
  constructor(message: string, code: string = "INVALID_INPUT") {
    super(message, code);
    this.name = "ValidationError";
  }
}

export class SecurityViolationError extends MiclawError {
  constructor(message: string, code: "PATH_BLOCKED" | "URL_BLOCKED" | "COST_EXCEEDED" | "RATE_LIMITED") {
    super(message, code);
    this.name = "SecurityViolationError";
  }
}
