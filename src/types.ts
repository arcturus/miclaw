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
}

// ─── Errors ────────────────────────────────────────────────

export class MikeClawError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "MikeClawError";
  }
}

export class RunnerError extends MikeClawError {
  constructor(message: string, code: "RUNNER_TIMEOUT" | "RUNNER_EXIT" | "RUNNER_PARSE" | "RUNNER_SPAWN") {
    super(message, code);
    this.name = "RunnerError";
  }
}

export class SessionError extends MikeClawError {
  constructor(message: string, code: "SESSION_CORRUPT" | "SESSION_EXPIRED" | "SESSION_LOCKED") {
    super(message, code);
    this.name = "SessionError";
  }
}

export class ConfigError extends MikeClawError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR");
    this.name = "ConfigError";
  }
}

export class ValidationError extends MikeClawError {
  constructor(message: string, code: string = "INVALID_INPUT") {
    super(message, code);
    this.name = "ValidationError";
  }
}
