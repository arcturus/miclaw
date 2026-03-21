// Layer 3: CronScheduler — scheduled job execution via orchestrator
import { readFileSync, existsSync } from "node:fs";
import cron from "node-cron";
import { resolvePath } from "./config.js";
import type { MiclawConfig } from "./config.js";
import type { Orchestrator } from "./orchestrator.js";
import type { CronJob, CronExecution } from "./types.js";

export type BroadcastCallback = (channelName: string, userId: string, message: string) => Promise<void>;

export class CronScheduler {
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  private jobs: CronJob[] = [];
  private execHistory: Map<string, CronExecution[]> = new Map();

  constructor(
    private orchestrator: Orchestrator,
    private config: MiclawConfig,
    private broadcastCallback?: BroadcastCallback,
  ) {}

  /** Load jobs from config file and start enabled ones */
  start(): void {
    const jobsFile = resolvePath(this.config.cron.jobsFile);
    if (!existsSync(jobsFile)) {
      console.log("[cron] No jobs file found, skipping cron setup");
      return;
    }

    try {
      const raw = readFileSync(jobsFile, "utf-8");
      const parsed = JSON.parse(raw);
      this.jobs = Array.isArray(parsed) ? parsed : parsed.jobs ?? [];
    } catch (err) {
      console.warn(`[cron] Error loading jobs: ${err}`);
      return;
    }

    for (const job of this.jobs) {
      if (!job.enabled) continue;
      this.scheduleJob(job);
    }

    console.log(`[cron] Scheduled ${this.tasks.size} jobs`);
  }

  /** Stop all scheduled jobs */
  stop(): void {
    for (const [id, task] of this.tasks) {
      task.stop();
    }
    this.tasks.clear();
  }

  /** Reload jobs from the config file, stopping old tasks and scheduling new ones */
  reload(): { added: number; removed: number; total: number } {
    const oldIds = new Set(this.tasks.keys());
    this.stop();
    this.jobs = [];

    const jobsFile = resolvePath(this.config.cron.jobsFile);
    if (!existsSync(jobsFile)) {
      console.log("[cron] No jobs file found during reload");
      return { added: 0, removed: oldIds.size, total: 0 };
    }

    try {
      const raw = readFileSync(jobsFile, "utf-8");
      const parsed = JSON.parse(raw);
      this.jobs = Array.isArray(parsed) ? parsed : parsed.jobs ?? [];
    } catch (err) {
      console.warn(`[cron] Error loading jobs during reload: ${err}`);
      return { added: 0, removed: oldIds.size, total: 0 };
    }

    for (const job of this.jobs) {
      if (!job.enabled) continue;
      this.scheduleJob(job);
    }

    const newIds = new Set(this.tasks.keys());
    const added = [...newIds].filter((id) => !oldIds.has(id)).length;
    const removed = [...oldIds].filter((id) => !newIds.has(id)).length;

    console.log(`[cron] Reloaded: ${this.tasks.size} jobs scheduled (${added} added, ${removed} removed)`);
    return { added, removed, total: this.tasks.size };
  }

  /** Schedule a single job */
  private scheduleJob(job: CronJob): void {
    if (!cron.validate(job.schedule)) {
      console.warn(`[cron] Invalid schedule for job ${job.id}: ${job.schedule}`);
      return;
    }

    const task = cron.schedule(job.schedule, () => {
      this.executeJob(job).catch((err) => {
        console.error(`[cron] Job ${job.id} failed: ${err}`);
      });
    }, {
      timezone: job.timezone ?? this.config.cron.timezone,
    });

    this.tasks.set(job.id, task);
  }

  /** Execute a job immediately */
  async runNow(jobId: string): Promise<void> {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) {
      console.warn(`[cron] Job ${jobId} not found`);
      return;
    }
    await this.executeJob(job);
  }

  /** Execute a cron job through the orchestrator */
  private async executeJob(job: CronJob): Promise<void> {
    console.log(`[cron] Executing job: ${job.id}`);
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    try {
      const message = this.resolveTemplates(job.message);

      const result = await this.orchestrator.handleMessage({
        channelId: "cron",
        userId: "system",
        message,
        agentId: job.agent,
        ephemeral: true,
      });

      switch (job.outputMode) {
        case "silent":
          // Result discarded
          break;
        case "journal":
          this.orchestrator.getMemoryManager().appendJournal({
            role: `cron:${job.id}`,
            content: result.result,
          });
          break;
        case "broadcast":
          if (job.broadcastTarget && this.broadcastCallback) {
            await this.broadcastCallback(
              job.broadcastTarget.channel,
              job.broadcastTarget.userId,
              `[${job.id}] ${result.result}`,
            );
          }
          break;
      }

      this.recordExecution({
        jobId: job.id,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: result.durationMs,
        status: "success",
        outputMode: job.outputMode,
        resultPreview: result.result,
      });

      console.log(`[cron] Job ${job.id} completed (${result.durationMs}ms)`);
    } catch (err) {
      this.recordExecution({
        jobId: job.id,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        status: "error",
        outputMode: job.outputMode,
        resultPreview: "",
        error: String(err),
      });
      throw err;
    }
  }

  /** Record an execution in the per-job history ring buffer */
  private recordExecution(exec: CronExecution): void {
    const list = this.execHistory.get(exec.jobId) ?? [];
    list.push(exec);
    this.execHistory.set(exec.jobId, list);
  }

  /** Get execution history, optionally filtered by job ID */
  getHistory(jobId?: string): CronExecution[] {
    if (jobId) {
      return [...(this.execHistory.get(jobId) ?? [])];
    }
    const all: CronExecution[] = [];
    for (const entries of this.execHistory.values()) {
      all.push(...entries);
    }
    return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Resolve template variables in job messages (single-pass to prevent injection) */
  private resolveTemplates(message: string): string {
    const replacements: Record<string, () => string> = {
      "{{DATE}}": () => new Date().toISOString().split("T")[0],
      "{{HEARTBEAT}}": () => this.readHeartbeat(),
      "{{JOURNALS_LAST_N}}": () => {
        const ctx = this.orchestrator.getMemoryManager().getContext();
        // Escape any template syntax in user content
        return ctx.replace(/\{\{/g, "\\{\\{");
      },
    };

    let result = message;
    for (const [key, valueFn] of Object.entries(replacements)) {
      if (result.includes(key)) {
        result = result.replaceAll(key, valueFn());
      }
    }
    return result;
  }

  /** Read the HEARTBEAT.md file */
  private readHeartbeat(): string {
    try {
      const heartbeatPath = resolvePath(this.config.soulDir + "/HEARTBEAT.md");
      if (existsSync(heartbeatPath)) {
        return readFileSync(heartbeatPath, "utf-8").trim();
      }
    } catch {}
    return "Check in: review pending tasks and recent activity.";
  }

  /** List all jobs */
  listJobs(): CronJob[] {
    return [...this.jobs];
  }
}
