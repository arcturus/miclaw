// Layer 2: Orchestrator — core coordination hub
import { ClaudeRunner, ProcessPool } from "./runner.js";
import { SoulLoader } from "./soul.js";
import { MemoryManager } from "./memory.js";
import { SkillLoader } from "./skills.js";
import { SessionManager } from "./session.js";
import { Learner } from "./learner.js";
import { getSecurityProfile, type MikeClawConfig } from "./config.js";
import type { MessageInput, MessageOutput, AgentConfig } from "./types.js";
import { ValidationError } from "./types.js";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

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

  constructor(private config: MikeClawConfig) {
    this.runner = new ClaudeRunner();
    this.pool = new ProcessPool(config.maxConcurrentProcesses, config.maxQueueDepth);
    this.soul = new SoulLoader();
    this.memory = new MemoryManager(config);
    this.skills = new SkillLoader(config.skillsDir);
    this.sessions = new SessionManager(config);
    this.learner = new Learner(config, this.memory, this.pool);

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
    const startTime = Date.now();
    const agentId = input.agentId ?? this.config.defaultAgent;
    const agent = this.agents.get(agentId);
    const security = getSecurityProfile(input.channelId, this.config);

    // Validate IDs to prevent path traversal
    if (input.agentId) validateId(input.agentId, "agentId");
    validateId(input.userId, "userId");

    // Validate message length
    if (input.message.length > security.maxMessageLength) {
      throw new ValidationError(`Message exceeds maximum length of ${security.maxMessageLength} characters`, "MESSAGE_TOO_LONG");
    }

    // Get or create session (skip for ephemeral)
    let session;
    if (!input.ephemeral) {
      session = this.sessions.getOrCreate(input.channelId, input.userId, agentId);

      // Check if session needs rotation
      if (this.sessions.needsRotation(session)) {
        console.log(`[orchestrator] Rotating session ${session.id} (${session.turnCount} turns)`);
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

    // Determine tools
    const allowedTools = [
      ...(security.allowedTools.length > 0 ? security.allowedTools : []),
      ...(agent?.allowedTools ?? []),
      ...this.skills.getAllAllowedTools(),
    ];

    // Acquire process pool slot
    await this.pool.acquire();
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
      });

      // Handle runner failure
      if (!result.ok) {
        // If resume failed, try without resume (session may have expired)
        if (session?.claudeSessionId && result.error?.includes("session")) {
          console.warn(`[orchestrator] Session expired, starting fresh: ${result.error}`);
          this.sessions.rotate(session);
          // Don't retry automatically — inform the user
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

      // Update session
      if (session && !input.ephemeral) {
        this.sessions.update(session.id, {
          claudeSessionId: result.sessionId || session.claudeSessionId,
          lastActiveAt: new Date().toISOString(),
          turnCount: session.turnCount + 1,
        });
        this.sessions.flush();
      }

      // Journal (non-ephemeral interactions)
      if (!input.ephemeral) {
        this.memory.appendJournal({ role: "user", content: input.message });
        this.memory.appendJournal({ role: "assistant", content: result.result });
      }

      // Self-learning (fire-and-forget, only if enabled for this channel)
      if (this.config.learning.afterEveryTurn && security.learningEnabled && !input.ephemeral) {
        this.learner.reflect(input.message, result.result).catch((err) => {
          console.warn(`[orchestrator] Learning reflection failed: ${err}`);
        });
      }

      return {
        result: result.result,
        sessionId: session?.id ?? `ephemeral:${Date.now()}`,
        cost: result.cost,
        durationMs: Date.now() - startTime,
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
  getConfig(): MikeClawConfig {
    return this.config;
  }

  /** Get registered agents */
  getAgents(): AgentConfig[] {
    return [...this.agents.values()];
  }
}
