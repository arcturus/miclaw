// Layer 2: SessionManager — file-based session persistence with in-memory cache
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolvePath } from "./config.js";
import type { MiclawConfig } from "./config.js";
import type { Session, SessionStore } from "./types.js";

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private dirty = false;
  private sessionsFile: string;

  constructor(private config: MiclawConfig) {
    const dir = resolvePath(config.sessionsDir);
    mkdirSync(dir, { recursive: true });
    this.sessionsFile = path.join(dir, "sessions.json");
    this.loadFromDisk();
  }

  /** Get or create a session for a channel+user+agent combo */
  getOrCreate(channelId: string, userId: string, agentId: string): Session {
    const key = `${channelId}:${userId}:${agentId}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const session: Session = {
      id: key,
      agentId,
      channelId,
      userId,
      claudeSessionId: null,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      turnCount: 0,
      metadata: {},
    };

    this.sessions.set(key, session);
    this.dirty = true;
    return session;
  }

  /** Update session fields after a turn */
  update(sessionId: string, updates: Partial<Pick<Session, "claudeSessionId" | "lastActiveAt" | "turnCount" | "metadata">>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (updates.claudeSessionId !== undefined) session.claudeSessionId = updates.claudeSessionId;
    if (updates.lastActiveAt) session.lastActiveAt = updates.lastActiveAt;
    if (updates.turnCount !== undefined) session.turnCount = updates.turnCount;
    if (updates.metadata) session.metadata = { ...session.metadata, ...updates.metadata };

    this.dirty = true;
  }

  /** Check if session needs rotation (too many turns) */
  needsRotation(session: Session): boolean {
    return session.turnCount >= this.config.maxTurnsPerSession;
  }

  /** Rotate a session: clear Claude session ID, reset turn count */
  rotate(session: Session): void {
    session.claudeSessionId = null;
    session.turnCount = 0;
    this.dirty = true;
  }

  /** Flush in-memory sessions to disk (atomic write) */
  flush(): void {
    if (!this.dirty) return;

    const store: SessionStore = {
      version: 1,
      sessions: Object.fromEntries(this.sessions),
    };

    const tmpPath = this.sessionsFile + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(store, null, 2), "utf-8");
    renameSync(tmpPath, this.sessionsFile);
    this.dirty = false;
  }

  /** Load sessions from disk */
  private loadFromDisk(): void {
    if (!existsSync(this.sessionsFile)) return;

    try {
      const raw = readFileSync(this.sessionsFile, "utf-8");
      const store: SessionStore = JSON.parse(raw);
      if (store.version !== 1) {
        console.warn(`[session] Unknown session store version ${store.version}, starting fresh`);
        return;
      }
      for (const [key, session] of Object.entries(store.sessions)) {
        this.sessions.set(key, session);
      }
    } catch (err) {
      console.warn(`[session] Error loading sessions: ${err}. Starting fresh.`);
      // Try .tmp backup
      const tmpPath = this.sessionsFile + ".tmp";
      if (existsSync(tmpPath)) {
        try {
          const raw = readFileSync(tmpPath, "utf-8");
          const store: SessionStore = JSON.parse(raw);
          for (const [key, session] of Object.entries(store.sessions)) {
            this.sessions.set(key, session);
          }
          console.log(`[session] Recovered from .tmp backup`);
        } catch {
          // Give up, start fresh
        }
      }
    }
  }

  /** List all sessions */
  listAll(): Session[] {
    return [...this.sessions.values()];
  }

  /** Get session count */
  count(): number {
    return this.sessions.size;
  }

  /** Get a session by ID */
  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** Garbage collect expired sessions */
  gc(): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.config.sessionTtlDays);
    const cutoffStr = cutoff.toISOString();
    let removed = 0;

    for (const [key, session] of this.sessions) {
      if (session.lastActiveAt < cutoffStr) {
        this.sessions.delete(key);
        removed++;
        this.dirty = true;
      }
    }

    return removed;
  }
}
