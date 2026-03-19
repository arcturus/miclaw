// Layer 3: Web channel — HTTP server + static chat UI + admin dashboard
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Channel, MessageHandler } from "../types.js";
import { ValidationError, SecurityViolationError } from "../types.js";
import { resolvePath, type MikeClawConfig } from "../config.js";
import type { Orchestrator } from "../orchestrator.js";
import type { CronScheduler } from "../cron.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class WebChannel implements Channel {
  readonly name = "web";
  private server: Server | null = null;
  private handler: MessageHandler | null = null;
  private orchestrator: Orchestrator | null = null;
  private cronScheduler: CronScheduler | null = null;
  private startedAt: string = new Date().toISOString();
  /** SSE clients keyed by userId → set of open responses */
  private sseClients: Map<string, Set<ServerResponse>> = new Map();

  constructor(private config: MikeClawConfig) {}

  /** Inject orchestrator reference for admin API */
  setOrchestrator(orchestrator: Orchestrator): void {
    this.orchestrator = orchestrator;
  }

  /** Inject cron scheduler reference for admin API */
  setCronScheduler(scheduler: CronScheduler): void {
    this.cronScheduler = scheduler;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const webConfig = this.config.channels.web;

    this.server = createServer(async (req, res) => {
      // Security headers
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:");

      // CORS
      const origin = req.headers.origin;
      const allowed = webConfig.corsOrigins ?? [`http://${webConfig.host ?? "127.0.0.1"}:${webConfig.port}`];
      if (origin && allowed.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        await this.route(req, res);
      } catch (err) {
        const status = err instanceof SecurityViolationError
          ? (err.code === "RATE_LIMITED" ? 429 : 403)
          : err instanceof ValidationError ? 400 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }));
      }
    });

    const host = webConfig.host ?? "127.0.0.1";
    const port = webConfig.port;
    return new Promise<void>((resolve, reject) => {
      this.server!.once("error", (err) => {
        reject(err);
      });
      this.server!.listen(port, host, () => {
        console.log(`[web] Chat UI available at http://${host}:${port}`);
        console.log(`[web] Admin dashboard at http://${host}:${port}/admin`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    // Close all SSE connections
    for (const set of this.sseClients.values()) {
      for (const res of set) {
        try { res.end(); } catch { /* already closed */ }
      }
    }
    this.sseClients.clear();
    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  async send(userId: string, message: string): Promise<boolean> {
    // Broadcast to all SSE clients for this userId (or all clients if userId is "*")
    const targets = userId === "*"
      ? [...this.sseClients.values()].flatMap((s) => [...s])
      : [...(this.sseClients.get(userId) ?? [])];

    if (targets.length === 0) {
      console.log(`[web] No SSE clients for ${userId}, message dropped`);
      return false;
    }

    const payload = JSON.stringify({ type: "broadcast", message, timestamp: new Date().toISOString() });
    for (const res of targets) {
      try {
        res.write(`data: ${payload}\n\n`);
      } catch {
        // Client disconnected; cleanup happens in the close handler
      }
    }

    console.log(`[web] Broadcast sent to ${targets.length} client(s) for ${userId}`);
    return true;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // Chat UI
    if (req.method === "GET" && url.pathname === "/") {
      return this.serveFile(res, "web/index.html", "text/html");
    }

    // Admin dashboard
    if (req.method === "GET" && url.pathname === "/admin") {
      return this.serveFile(res, "web/admin.html", "text/html");
    }

    // Chat API
    if (req.method === "POST" && url.pathname === "/api/chat") {
      return this.handleChat(req, res);
    }

    // Health
    if (req.method === "GET" && url.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // SSE stream for broadcast messages
    if (req.method === "GET" && url.pathname === "/api/events") {
      return this.handleSSE(req, res);
    }

    // ─── Admin API (requires authentication) ───────────────
    if (url.pathname.startsWith("/api/admin/")) {
      if (!this.authenticate(req, res)) return;
      if (req.method === "POST" && url.pathname === "/api/admin/cron/run") {
        return this.adminCronRun(req, res);
      }
      if (req.method === "GET") {
        return this.handleAdmin(req, res, url);
      }
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  /** Authenticate a request (timing-safe comparison, rejects empty keys) */
  private authenticate(req: IncomingMessage, res: ServerResponse): boolean {
    const authConfig = this.config.channels.web.auth;
    if (authConfig.type === "none") return true;

    // Reject if no API key is configured (prevents empty-string bypass)
    if (!authConfig.apiKey) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server misconfigured: no API key set" }));
      return false;
    }

    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing Authorization header" }));
      return false;
    }

    const token = header.slice(7);
    if (!token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Empty token" }));
      return false;
    }

    // Timing-safe comparison to prevent timing attacks
    const expected = Buffer.from(authConfig.apiKey, "utf-8");
    const received = Buffer.from(token, "utf-8");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid API key" }));
      return false;
    }

    return true;
  }

  /** Authenticate SSE requests — accepts token via query param since EventSource can't send headers */
  private authenticateSSE(req: IncomingMessage, res: ServerResponse): boolean {
    const authConfig = this.config.channels.web.auth;
    if (authConfig.type === "none") return true;

    if (!authConfig.apiKey) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server misconfigured: no API key set" }));
      return false;
    }

    // Try Authorization header first, then fall back to ?token= query param
    const header = req.headers.authorization;
    let token: string | undefined;
    if (header?.startsWith("Bearer ")) {
      token = header.slice(7);
    } else {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      token = url.searchParams.get("token") ?? undefined;
    }

    if (!token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing token" }));
      return false;
    }

    const expected = Buffer.from(authConfig.apiKey, "utf-8");
    const received = Buffer.from(token, "utf-8");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid token" }));
      return false;
    }

    return true;
  }

  private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authenticate(req, res)) return;

    const body = await readBody(req, 100_000);
    let parsed: { message?: string; agentId?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new ValidationError("Invalid JSON body");
    }

    if (!parsed.message || typeof parsed.message !== "string") {
      throw new ValidationError("message field is required");
    }

    if (!this.handler) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Service not ready" }));
      return;
    }

    const ip = req.socket.remoteAddress ?? "unknown";
    const userId = `web-${simpleHash(ip)}`;

    const result = await this.handler({
      channelId: "web",
      userId,
      message: parsed.message,
      agentId: parsed.agentId,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      result: result.result,
      sessionId: result.sessionId,
      cost: result.cost,
      durationMs: result.durationMs,
    }));
  }

  /** SSE endpoint — clients connect to receive broadcast messages */
  private handleSSE(req: IncomingMessage, res: ServerResponse): void {
    // EventSource cannot send Authorization headers, so accept token via query param
    if (!this.authenticateSSE(req, res)) return;

    const ip = req.socket.remoteAddress ?? "unknown";
    const userId = `web-${simpleHash(ip)}`;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Send initial connected event
    res.write(`data: ${JSON.stringify({ type: "connected", userId })}\n\n`);

    // Register client
    if (!this.sseClients.has(userId)) {
      this.sseClients.set(userId, new Set());
    }
    this.sseClients.get(userId)!.add(res);
    console.log(`[web] SSE client connected: ${userId} (${this.countSSEClients()} total)`);

    // Keepalive every 30s to prevent proxy/browser timeout
    const keepalive = setInterval(() => {
      try { res.write(": keepalive\n\n"); } catch { /* cleanup below */ }
    }, 30_000);

    // Cleanup on disconnect
    const cleanup = () => {
      clearInterval(keepalive);
      const set = this.sseClients.get(userId);
      if (set) {
        set.delete(res);
        if (set.size === 0) this.sseClients.delete(userId);
      }
      console.log(`[web] SSE client disconnected: ${userId} (${this.countSSEClients()} total)`);
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
  }

  private countSSEClients(): number {
    let count = 0;
    for (const set of this.sseClients.values()) count += set.size;
    return count;
  }

  // ─── Admin API Handler ─────────────────────────────────

  private async handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.orchestrator) {
      this.json(res, 503, { error: "Orchestrator not available" });
      return;
    }

    const route = url.pathname.replace("/api/admin/", "");

    switch (route) {
      case "overview":
        return this.adminOverview(res);
      case "sessions":
        return this.adminSessions(res);
      case "memory":
        return this.adminMemory(res);
      case "journals":
        return this.adminJournals(res, url);
      case "learnings":
        return this.adminLearnings(res);
      case "soul":
        return this.adminSoul(res);
      case "skills":
        return this.adminSkills(res);
      case "cron":
        return this.adminCron(res);
      case "config":
        return this.adminConfig(res);
      case "agents":
        return this.adminAgents(res);
      case "security":
        return this.adminSecurity(res, url);
      default:
        this.json(res, 404, { error: `Unknown admin route: ${route}` });
    }
  }

  private adminOverview(res: ServerResponse): void {
    const sessions = this.orchestrator!.getSessionManager();
    const memory = this.orchestrator!.getMemoryManager();
    const skills = this.orchestrator!.getSkillLoader();
    const allSessions = sessions.listAll();

    const activeLast24h = allSessions.filter((s) => {
      const last = new Date(s.lastActiveAt).getTime();
      return Date.now() - last < 24 * 60 * 60 * 1000;
    });

    const totalTurns = allSessions.reduce((sum, s) => sum + s.turnCount, 0);

    const channelBreakdown: Record<string, number> = {};
    for (const s of allSessions) {
      channelBreakdown[s.channelId] = (channelBreakdown[s.channelId] ?? 0) + 1;
    }

    this.json(res, 200, {
      startedAt: this.startedAt,
      uptime: Math.floor((Date.now() - new Date(this.startedAt).getTime()) / 1000),
      sessions: {
        total: allSessions.length,
        activeLast24h: activeLast24h.length,
        totalTurns,
        channelBreakdown,
      },
      memory: {
        learningCount: memory.countLearnings(),
        journalDates: memory.listJournalDates().length,
      },
      skills: {
        loaded: skills.load().length,
      },
      cron: {
        jobs: this.cronScheduler?.listJobs().length ?? 0,
        enabledJobs: this.cronScheduler?.listJobs().filter((j) => j.enabled).length ?? 0,
      },
      agents: this.orchestrator!.getAgents().length,
      security: this.getSecurityStats(),
    });
  }

  /** Quick violation count from audit log (for overview card) */
  private getSecurityStats(): { violations: number; totalEvents: number } {
    const auditPath = resolvePath("./logs/audit.jsonl");
    if (!existsSync(auditPath)) return { violations: 0, totalEvents: 0 };
    try {
      const raw = readFileSync(auditPath, "utf-8").trim();
      if (!raw) return { violations: 0, totalEvents: 0 };
      const lines = raw.split("\n");
      let violations = 0;
      for (const line of lines) {
        if (line.includes('"violation"')) violations++;
      }
      return { violations, totalEvents: lines.length };
    } catch {
      return { violations: 0, totalEvents: 0 };
    }
  }

  private adminSessions(res: ServerResponse): void {
    const sessions = this.orchestrator!.getSessionManager().listAll();
    const sorted = sessions.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
    this.json(res, 200, {
      count: sorted.length,
      sessions: sorted.map((s) => ({
        id: s.id,
        agentId: s.agentId,
        channelId: s.channelId,
        userId: s.userId,
        claudeSessionId: s.claudeSessionId ? `${s.claudeSessionId.slice(0, 8)}...` : null,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        turnCount: s.turnCount,
      })),
    });
  }

  private adminMemory(res: ServerResponse): void {
    const memory = this.orchestrator!.getMemoryManager();
    this.json(res, 200, {
      longTermMemory: memory.readMemory(),
      learningCount: memory.countLearnings(),
      journalDates: memory.listJournalDates(),
    });
  }

  private adminJournals(res: ServerResponse, url: URL): void {
    const memory = this.orchestrator!.getMemoryManager();
    const date = url.searchParams.get("date");

    if (date) {
      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        this.json(res, 400, { error: "Invalid date format. Use YYYY-MM-DD" });
        return;
      }
      const content = memory.readJournal(date);
      this.json(res, 200, { date, content: content ?? "No journal for this date.", entries: parseJournalEntries(content) });
    } else {
      const dates = memory.listJournalDates();
      // Return the most recent journal by default
      const latest = dates[0];
      const content = latest ? memory.readJournal(latest) : null;
      this.json(res, 200, {
        dates,
        latest: latest ?? null,
        content: content ?? null,
        entries: parseJournalEntries(content),
      });
    }
  }

  private adminLearnings(res: ServerResponse): void {
    const memory = this.orchestrator!.getMemoryManager();
    const raw = memory.readLearnings();
    const entries = raw
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim());

    this.json(res, 200, {
      count: entries.length,
      maxEntries: this.config.learning.maxLearningEntries,
      entries,
      raw,
    });
  }

  private adminSoul(res: ServerResponse): void {
    const soul = this.orchestrator!.getSoulLoader();
    const config = this.orchestrator!.getConfig();
    const files = soul.readAll(config.soulDir);
    this.json(res, 200, {
      soulDir: config.soulDir,
      files,
      assembledPrompt: soul.assemble(config.soulDir),
    });
  }

  private adminSkills(res: ServerResponse): void {
    const skills = this.orchestrator!.getSkillLoader();
    const loaded = skills.load();
    this.json(res, 200, {
      count: loaded.length,
      skills: loaded.map((s) => ({
        name: s.name,
        description: s.description,
        allowedTools: s.allowedTools,
        requires: s.requires,
        filePath: s.filePath,
        bodyLength: s.body.length,
      })),
      allAllowedTools: skills.getAllAllowedTools(),
    });
  }

  private adminCron(res: ServerResponse): void {
    const jobs = this.cronScheduler?.listJobs() ?? [];
    const allHistory = this.cronScheduler?.getHistory() ?? [];
    this.json(res, 200, {
      enabled: this.config.cron.enabled,
      jobsFile: this.config.cron.jobsFile,
      timezone: this.config.cron.timezone ?? "system",
      count: jobs.length,
      jobs: jobs.map((j) => {
        const jobHistory = this.cronScheduler?.getHistory(j.id) ?? [];
        return {
          id: j.id,
          schedule: j.schedule,
          agent: j.agent,
          enabled: j.enabled,
          outputMode: j.outputMode,
          message: j.message.slice(0, 200),
          timezone: j.timezone,
          lastRun: jobHistory.at(-1) ?? null,
          history: jobHistory.slice(-10),
        };
      }),
      recentExecutions: allHistory.slice(0, 50),
    });
  }

  private async adminCronRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.cronScheduler) {
      this.json(res, 503, { error: "Cron scheduler not available" });
      return;
    }

    const body = await readBody(req, 1000);
    const { jobId } = JSON.parse(body);
    if (!jobId || typeof jobId !== "string") {
      this.json(res, 400, { error: "Missing jobId" });
      return;
    }

    const job = this.cronScheduler.listJobs().find((j) => j.id === jobId);
    if (!job) {
      this.json(res, 404, { error: `Job "${jobId}" not found` });
      return;
    }

    try {
      await this.cronScheduler.runNow(jobId);
      const history = this.cronScheduler.getHistory(jobId);
      const lastRun = history.at(-1) ?? null;
      this.json(res, 200, { ok: true, jobId, lastRun });
    } catch (err) {
      const history = this.cronScheduler.getHistory(jobId);
      const lastRun = history.at(-1) ?? null;
      this.json(res, 200, { ok: false, jobId, lastRun, error: String(err) });
    }
  }

  private adminConfig(res: ServerResponse): void {
    const config = this.orchestrator!.getConfig();
    // Sanitize: don't expose API keys
    const sanitized = {
      ...config,
      channels: {
        ...config.channels,
        web: {
          ...config.channels.web,
          auth: {
            type: config.channels.web.auth.type,
            apiKey: config.channels.web.auth.apiKey ? "***" : undefined,
          },
        },
      },
    };
    this.json(res, 200, sanitized);
  }

  private adminAgents(res: ServerResponse): void {
    const agents = this.orchestrator!.getAgents();
    this.json(res, 200, {
      count: agents.length,
      agents,
    });
  }

  private adminSecurity(res: ServerResponse, url: URL): void {
    const auditPath = resolvePath("./logs/audit.jsonl");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10), 1000);
    const filter = url.searchParams.get("filter"); // "violations", "tool_use", or null for all

    if (!existsSync(auditPath)) {
      this.json(res, 200, {
        entries: [],
        violations: [],
        stats: { total: 0, violations: 0, toolUses: 0, uniqueUsers: 0 },
      });
      return;
    }

    let lines: string[];
    try {
      const raw = readFileSync(auditPath, "utf-8").trim();
      lines = raw ? raw.split("\n") : [];
    } catch {
      this.json(res, 200, { entries: [], violations: [], stats: { total: 0, violations: 0, toolUses: 0, uniqueUsers: 0 } });
      return;
    }

    // Parse all entries
    const entries: any[] = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }

    // Compute stats
    const violations = entries.filter((e) => e.action === "violation");
    const toolUses = entries.filter((e) => e.action === "tool_use");
    const uniqueUsers = new Set(entries.map((e) => e.userId)).size;

    // Tool usage breakdown
    const toolCounts: Record<string, number> = {};
    for (const e of toolUses) {
      toolCounts[e.tool ?? "unknown"] = (toolCounts[e.tool ?? "unknown"] ?? 0) + 1;
    }

    // Violations by type
    const violationsByType: Record<string, number> = {};
    for (const v of violations) {
      const reason = (v.detail?.reason as string)?.split(":")[0] ?? "unknown";
      violationsByType[reason] = (violationsByType[reason] ?? 0) + 1;
    }

    // Filter
    let filtered = entries;
    if (filter === "violations") {
      filtered = violations;
    } else if (filter === "tool_use") {
      filtered = toolUses;
    }

    // Return most recent entries (tail of the log)
    const recent = filtered.slice(-limit).reverse();

    this.json(res, 200, {
      entries: recent,
      stats: {
        total: entries.length,
        violations: violations.length,
        toolUses: toolUses.length,
        uniqueUsers,
        toolCounts,
        violationsByType,
      },
    });
  }

  // ─── Helpers ─────────────────────────────────────────────

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
  }

  private serveFile(res: ServerResponse, relativePath: string, contentType: string): void {
    const filePath = path.join(__dirname, relativePath);
    if (!existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const content = readFileSync(filePath, "utf-8");
    res.writeHead(200, { "Content-Type": `${contentType}; charset=utf-8` });
    res.end(content);
  }
}

/** Parse journal markdown into structured entries */
function parseJournalEntries(content: string | null): Array<{ time: string; role: string; content: string }> {
  if (!content) return [];
  return content.split("\n")
    .filter((line) => line.startsWith("- **["))
    .map((line) => {
      const match = line.match(/^- \*\*\[(\d{2}:\d{2}:\d{2})\] (.+?)\*\*: (.+)$/);
      if (!match) return { time: "", role: "unknown", content: line };
      return { time: match[1], role: match[2], content: match[3] };
    });
}

/** Read request body with size limit */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.destroy();
        reject(new ValidationError(`Request body too large (max ${maxBytes} bytes)`));
        return;
      }
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}
