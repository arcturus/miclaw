// Layer 2: Orchestrator — core coordination hub
import { ClaudeRunner, ProcessPool } from "./runner.js";
import { SoulLoader } from "./soul.js";
import { MemoryManager } from "./memory.js";
import { SkillLoader } from "./skills.js";
import { SessionManager } from "./session.js";
import { Learner } from "./learner.js";
import { getSecurityProfile, resolvePath, type MiclawConfig } from "./config.js";
import type { MessageInput, MessageOutput, AgentConfig } from "./types.js";
import { ValidationError, SecurityViolationError } from "./types.js";
import { RateLimiter, AuditLogger } from "./security.js";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
let msgSeq = 0;

function validateId(value: string, fieldName: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new ValidationError(`Invalid ${fieldName}: must match ${ID_PATTERN}`);
  }
  return value;
}

export class Orchestrator {
  private runner: ClaudeRunner;
  private pool: ProcessPool;
  private soul: SoulLoader;
  private memory: MemoryManager;
  private skills: SkillLoader;
  private sessions: SessionManager;
  private learner: Learner;
  private sessionLocks: Map<string, Promise<void>> = new Map();
  private agents: Map<string, AgentConfig> = new Map();
  private rateLimiter = new RateLimiter();
  private auditLogger: AuditLogger;

  constructor(private config: MiclawConfig) {
    this.runner = new ClaudeRunner();
    this.pool = new ProcessPool(config.maxConcurrentProcesses, config.maxQueueDepth);
    this.soul = new SoulLoader();
    this.memory = new MemoryManager(config);
    this.skills = new SkillLoader(config.skillsDir);
    this.sessions = new SessionManager(config);
    this.learner = new Learner(config, this.memory, this.pool);
    this.auditLogger = new AuditLogger(resolvePath("./logs/audit.jsonl"));

    // Pre-load skills
    this.skills.load();

    // Run session GC on startup
    const removed = this.sessions.gc();
    if (removed > 0) {
      console.log(`[session] Garbage collected ${removed} expired sessions`);
      this.sessions.flush();
    }
  }

  /** Register an agent config */
  registerAgent(agent: AgentConfig): void {
    this.agents.set(agent.id, agent);
  }

  /** Handle an incoming message from any channel */
  async handleMessage(input: MessageInput): Promise<MessageOutput> {
    // Per-session serialization to prevent concurrent --resume corruption
    const sessionKey = `${input.channelId}:${input.userId}:${input.agentId ?? this.config.defaultAgent}`;
    const prev = this.sessionLocks.get(sessionKey) ?? Promise.resolve();
    const current = prev.then(
      () => this._handleMessage(input),
      () => this._handleMessage(input), // run even if previous failed
    );
    // Clean up lock entry once the promise chain settles (prevents memory leak)
    const settled = current.then(() => {}, () => {});
    this.sessionLocks.set(sessionKey, settled);
    settled.then(() => {
      // Only delete if this is still the latest promise for this key
      if (this.sessionLocks.get(sessionKey) === settled) {
        this.sessionLocks.delete(sessionKey);
      }
    });
    return current;
  }

  private async _handleMessage(input: MessageInput): Promise<MessageOutput> {
    const mid = ++msgSeq;
    const startTime = Date.now();
    const agentId = input.agentId ?? this.config.defaultAgent;
    const agent = this.agents.get(agentId);
    const security = getSecurityProfile(input.channelId, this.config);

    // Enforce agentWriteToMemoryEnabled: when false, block all writes to memory/
    if (!security.agentWriteToMemoryEnabled) {
      security.writeBlockedPaths = [...(security.writeBlockedPaths ?? []), "memory/"];
    }

    // Privileged cron jobs (e.g., consolidation) bypass writeBlockedPaths
    if (input.metadata?.privileged && input.channelId === "cron") {
      security.writeBlockedPaths = [];
    }

    const msgPreview = input.message.slice(0, 100).replace(/\n/g, "\\n");
    console.log(`[msg:${mid}] ── incoming ──────────────────────────────`);
    console.log(`[msg:${mid}] channel=${input.channelId} user=${input.userId} agent=${agentId} ephemeral=${!!input.ephemeral}`);
    console.log(`[msg:${mid}] message: ${msgPreview}${input.message.length > 100 ? `... (${input.message.length} chars)` : ""}`);

    // Validate IDs to prevent path traversal
    if (input.agentId) validateId(input.agentId, "agentId");
    validateId(input.userId, "userId");

    // Rate limiting
    if (security.rateLimitPerMinute > 0 && !this.rateLimiter.check(input.userId, security.rateLimitPerMinute)) {
      console.warn(`[msg:${mid}] ✗ rate limited: ${input.userId}`);
      throw new SecurityViolationError(`Rate limit exceeded (${security.rateLimitPerMinute} req/min)`, "RATE_LIMITED");
    }

    // Validate message length
    if (input.message.length > security.maxMessageLength) {
      console.warn(`[msg:${mid}] ✗ rejected: message too long (${input.message.length} > ${security.maxMessageLength})`);
      throw new ValidationError(`Message exceeds maximum length of ${security.maxMessageLength} characters`, "MESSAGE_TOO_LONG");
    }

    // Audit: request start
    if (security.auditEnabled) {
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        channelId: input.channelId,
        userId: input.userId,
        agentId,
        action: "request_start",
        detail: { messageLength: input.message.length, ephemeral: !!input.ephemeral },
      });
    }

    // Get or create session (skip for ephemeral)
    let session;
    if (!input.ephemeral) {
      session = this.sessions.getOrCreate(input.channelId, input.userId, agentId);
      console.log(`[msg:${mid}] session=${session.id} claude_session=${session.claudeSessionId || "new"} turns=${session.turnCount}`);

      // Check if session needs rotation
      if (this.sessions.needsRotation(session)) {
        console.log(`[msg:${mid}] rotating session (${session.turnCount} turns)`);
        this.sessions.rotate(session);
      }
    }

    // Assemble soul prompt
    const soulDir = agent?.soulDir ?? this.config.soulDir;
    const soulPrompt = this.soul.assemble(soulDir);
    const memoryContext = this.memory.getContext();
    const skillsSection = this.skills.getPromptSection();

    const fullPrompt = [soulPrompt, memoryContext, skillsSection]
      .filter(Boolean)
      .join("\n\n---\n\n");

    console.log(`[msg:${mid}] prompt: soul=${soulPrompt.length}b memory=${memoryContext.length}b skills=${skillsSection.length}b total=${fullPrompt.length}b mode=${this.config.promptMode}`);

    // Determine tools
    const allowedTools = [
      ...(security.allowedTools.length > 0 ? security.allowedTools : []),
      ...(agent?.allowedTools ?? []),
      ...this.skills.getAllAllowedTools(),
    ];

    if (allowedTools.length > 0) {
      console.log(`[msg:${mid}] allowed-tools: [${[...new Set(allowedTools)].join(", ")}]`);
    }

    // Acquire process pool slot
    console.log(`[msg:${mid}] acquiring pool slot...`);
    await this.pool.acquire();
    console.log(`[msg:${mid}] pool slot acquired, dispatching to claude`);

    try {
      const result = await this.runner.run({
        message: input.message,
        ...(this.config.promptMode === "append"
          ? { appendSystemPrompt: fullPrompt }
          : { systemPrompt: fullPrompt }),
        ...(session?.claudeSessionId ? { resume: session.claudeSessionId } : {}),
        model: agent?.model ?? this.config.defaultModel,
        allowedTools: allowedTools.length > 0 ? [...new Set(allowedTools)] : undefined,
        mcpConfig: agent?.mcpConfig ?? this.config.mcpConfig ?? undefined,
        timeoutMs: security.maxTimeoutMs,
        permissionMode: agent?.permissionMode ?? security.permissionMode,
        securityProfile: security,
        securityContext: { channelId: input.channelId, userId: input.userId, agentId },
      });

      // Handle runner failure
      if (!result.ok) {
        console.warn(`[msg:${mid}] ✗ runner failed: ${result.error}`);
        // If resume failed, try without resume (session may have expired)
        if (session?.claudeSessionId && result.error?.includes("session")) {
          console.warn(`[msg:${mid}] session expired, rotating`);
          this.sessions.rotate(session);
          return {
            result: "Your session has expired. Starting a new conversation. Please send your message again.",
            sessionId: session.id,
            durationMs: Date.now() - startTime,
          };
        }

        return {
          result: result.error ?? "An error occurred.",
          sessionId: session?.id ?? "",
          cost: result.cost,
          durationMs: Date.now() - startTime,
        };
      }

      const totalMs = Date.now() - startTime;
      console.log(`[msg:${mid}] ✓ ok cost=$${result.cost?.toFixed(4) ?? "?"} total=${totalMs}ms`);

      // Update session
      if (session && !input.ephemeral) {
        this.sessions.update(session.id, {
          claudeSessionId: result.sessionId || session.claudeSessionId,
          lastActiveAt: new Date().toISOString(),
          turnCount: session.turnCount + 1,
        });
        this.sessions.flush();
        console.log(`[msg:${mid}] session updated: claude_session=${result.sessionId || session.claudeSessionId} turns=${session.turnCount + 1}`);
      }

      // Journal (non-ephemeral interactions)
      if (!input.ephemeral) {
        this.memory.appendJournal({ role: "user", content: input.message });
        this.memory.appendJournal({ role: "assistant", content: result.result });
        console.log(`[msg:${mid}] journal written`);
      }

      // Self-learning (fire-and-forget, only if enabled for this channel)
      if (this.config.learning.afterEveryTurn && security.learningEnabled && !input.ephemeral) {
        console.log(`[msg:${mid}] triggering self-learning reflection`);
        this.learner.reflect(input.message, result.result).catch((err) => {
          console.warn(`[msg:${mid}] learning reflection failed: ${err}`);
        });
      }

      // Audit: request end
      if (security.auditEnabled) {
        this.auditLogger.log({
          timestamp: new Date().toISOString(),
          channelId: input.channelId,
          userId: input.userId,
          agentId,
          action: "request_end",
          detail: { cost: result.cost, durationMs: totalMs, ok: result.ok },
        });
      }

      // Post-hoc cost enforcement
      if (security.maxCostPerRequest > 0 && result.cost && result.cost > security.maxCostPerRequest) {
        console.warn(`[msg:${mid}] ✗ cost exceeded: $${result.cost.toFixed(4)} > $${security.maxCostPerRequest}`);
        if (security.auditEnabled) {
          this.auditLogger.log({
            timestamp: new Date().toISOString(),
            channelId: input.channelId,
            userId: input.userId,
            agentId,
            action: "violation",
            detail: { reason: "COST_EXCEEDED", cost: result.cost, limit: security.maxCostPerRequest },
          });
        }
      }

      console.log(`[msg:${mid}] ── done ──────────────────────────────────`);
      return {
        result: result.result,
        sessionId: session?.id ?? `ephemeral:${Date.now()}`,
        cost: result.cost,
        durationMs: totalMs,
      };
    } finally {
      this.pool.release();
    }
  }

  /** Get the session manager (for shutdown flush) */
  getSessionManager(): SessionManager {
    return this.sessions;
  }

  /** Get the memory manager (for cron template resolution) */
  getMemoryManager(): MemoryManager {
    return this.memory;
  }

  /** Get the skill loader (for admin) */
  getSkillLoader(): SkillLoader {
    return this.skills;
  }

  /** Get the soul loader (for admin) */
  getSoulLoader(): SoulLoader {
    return this.soul;
  }

  /** Get config (for admin) */
  getConfig(): MiclawConfig {
    return this.config;
  }

  /** Get registered agents */
  getAgents(): AgentConfig[] {
    return [...this.agents.values()];
  }
}
