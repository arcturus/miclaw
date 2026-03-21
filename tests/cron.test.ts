import { describe, it, expect, vi, beforeEach } from "vitest";
import { CronScheduler } from "../src/cron.js";
import type { CronJob } from "../src/types.js";

// ─── Helpers ─────────────────────────────────────────────

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job",
    schedule: "*/5 * * * *",
    agent: "assistant",
    message: "hello",
    enabled: true,
    outputMode: "silent",
    ...overrides,
  };
}

function makeMockOrchestrator(result = "ok", durationMs = 42) {
  return {
    handleMessage: vi.fn().mockResolvedValue({ result, durationMs }),
    getMemoryManager: vi.fn().mockReturnValue({
      appendJournal: vi.fn(),
      getContext: vi.fn().mockReturnValue("some context"),
    }),
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    cron: {
      enabled: true,
      jobsFile: "./cron/jobs.json",
      timezone: undefined,
      ...overrides,
    },
    soulDir: "./soul",
  } as any;
}

// ─── Tests ───────────────────────────────────────────────

describe("CronScheduler", () => {
  let orchestrator: ReturnType<typeof makeMockOrchestrator>;
  let scheduler: CronScheduler;

  beforeEach(() => {
    orchestrator = makeMockOrchestrator();
    scheduler = new CronScheduler(orchestrator as any, makeConfig());
  });

  describe("listJobs", () => {
    it("returns empty array before start", () => {
      expect(scheduler.listJobs()).toEqual([]);
    });
  });

  describe("getHistory", () => {
    it("returns empty array when no executions", () => {
      expect(scheduler.getHistory()).toEqual([]);
      expect(scheduler.getHistory("nonexistent")).toEqual([]);
    });
  });

  describe("runNow", () => {
    it("does nothing for unknown job id", async () => {
      await scheduler.runNow("nonexistent");
      expect(orchestrator.handleMessage).not.toHaveBeenCalled();
      expect(scheduler.getHistory()).toEqual([]);
    });
  });

  describe("execution history tracking", () => {
    // We need to inject jobs into the scheduler to test runNow.
    // The simplest way is to use start() with a temp file, but that couples to fs.
    // Instead we use a helper that accesses internals for testing.
    function injectJob(sched: CronScheduler, job: CronJob) {
      // Access private jobs array
      (sched as any).jobs.push(job);
    }

    it("records successful execution in history", async () => {
      const job = makeJob({ id: "job-a", outputMode: "silent" });
      injectJob(scheduler, job);

      await scheduler.runNow("job-a");

      const history = scheduler.getHistory("job-a");
      expect(history).toHaveLength(1);
      expect(history[0].jobId).toBe("job-a");
      expect(history[0].status).toBe("success");
      expect(history[0].durationMs).toBe(42);
      expect(history[0].outputMode).toBe("silent");
      expect(history[0].resultPreview).toBe("ok");
      expect(history[0].error).toBeUndefined();
      expect(history[0].startedAt).toBeTruthy();
      expect(history[0].completedAt).toBeTruthy();
    });

    it("records error execution in history", async () => {
      orchestrator.handleMessage.mockRejectedValue(new Error("boom"));
      const job = makeJob({ id: "job-err" });
      injectJob(scheduler, job);

      await expect(scheduler.runNow("job-err")).rejects.toThrow("boom");

      const history = scheduler.getHistory("job-err");
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe("error");
      expect(history[0].error).toContain("boom");
      expect(history[0].resultPreview).toBe("");
    });

    it("tracks multiple executions per job", async () => {
      const job = makeJob({ id: "job-multi" });
      injectJob(scheduler, job);

      await scheduler.runNow("job-multi");
      await scheduler.runNow("job-multi");
      await scheduler.runNow("job-multi");

      expect(scheduler.getHistory("job-multi")).toHaveLength(3);
    });

    it("preserves full history without capping", async () => {
      const job = makeJob({ id: "job-cap" });
      injectJob(scheduler, job);

      const runs = 10;
      for (let i = 0; i < runs; i++) {
        await scheduler.runNow("job-cap");
      }

      expect(scheduler.getHistory("job-cap")).toHaveLength(runs);
    });

    it("getHistory without jobId returns all jobs sorted by startedAt desc", async () => {
      const jobA = makeJob({ id: "aaa" });
      const jobB = makeJob({ id: "bbb" });
      injectJob(scheduler, jobA);
      injectJob(scheduler, jobB);

      await scheduler.runNow("aaa");
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 5));
      await scheduler.runNow("bbb");

      const all = scheduler.getHistory();
      expect(all).toHaveLength(2);
      // Most recent first
      expect(all[0].jobId).toBe("bbb");
      expect(all[1].jobId).toBe("aaa");
    });

    it("getHistory returns a copy, not the internal array", async () => {
      const job = makeJob({ id: "job-copy" });
      injectJob(scheduler, job);
      await scheduler.runNow("job-copy");

      const h1 = scheduler.getHistory("job-copy");
      h1.pop();
      expect(scheduler.getHistory("job-copy")).toHaveLength(1);
    });

    it("preserves full resultPreview without truncation", async () => {
      const longResult = "x".repeat(1000);
      orchestrator.handleMessage.mockResolvedValue({ result: longResult, durationMs: 10 });

      const job = makeJob({ id: "job-long" });
      injectJob(scheduler, job);
      await scheduler.runNow("job-long");

      const history = scheduler.getHistory("job-long");
      expect(history[0].resultPreview).toHaveLength(1000);
    });
  });

  describe("output modes", () => {
    function injectJob(sched: CronScheduler, job: CronJob) {
      (sched as any).jobs.push(job);
    }

    it("silent mode does not call appendJournal or broadcast", async () => {
      const job = makeJob({ id: "silent-job", outputMode: "silent" });
      injectJob(scheduler, job);
      await scheduler.runNow("silent-job");

      expect(orchestrator.getMemoryManager().appendJournal).not.toHaveBeenCalled();
    });

    it("journal mode calls appendJournal with cron role prefix", async () => {
      orchestrator.handleMessage.mockResolvedValue({ result: "summary text", durationMs: 10 });
      const job = makeJob({ id: "journal-job", outputMode: "journal" });
      injectJob(scheduler, job);
      await scheduler.runNow("journal-job");

      const mm = orchestrator.getMemoryManager();
      expect(mm.appendJournal).toHaveBeenCalledWith({
        role: "cron:journal-job",
        content: "summary text",
      });
    });

    it("broadcast mode calls broadcastCallback with target", async () => {
      const broadcastCb = vi.fn().mockResolvedValue(undefined);
      const sched = new CronScheduler(orchestrator as any, makeConfig(), broadcastCb);

      orchestrator.handleMessage.mockResolvedValue({ result: "alert!", durationMs: 5 });
      const job = makeJob({
        id: "broadcast-job",
        outputMode: "broadcast",
        broadcastTarget: { channel: "web", userId: "user1" },
      });
      (sched as any).jobs.push(job);
      await sched.runNow("broadcast-job");

      expect(broadcastCb).toHaveBeenCalledWith("web", "user1", "[broadcast-job] alert!");
    });

    it("broadcast mode does nothing without broadcastTarget", async () => {
      const broadcastCb = vi.fn();
      const sched = new CronScheduler(orchestrator as any, makeConfig(), broadcastCb);

      const job = makeJob({ id: "no-target", outputMode: "broadcast" });
      (sched as any).jobs.push(job);
      await sched.runNow("no-target");

      expect(broadcastCb).not.toHaveBeenCalled();
    });
  });

  describe("template resolution", () => {
    function injectJob(sched: CronScheduler, job: CronJob) {
      (sched as any).jobs.push(job);
    }

    it("resolves {{DATE}} to current date", async () => {
      const job = makeJob({ id: "tpl-date", message: "Report for {{DATE}}" });
      injectJob(scheduler, job);
      await scheduler.runNow("tpl-date");

      const call = orchestrator.handleMessage.mock.calls[0][0];
      const today = new Date().toISOString().split("T")[0];
      expect(call.message).toBe(`Report for ${today}`);
    });

    it("passes message through orchestrator with correct params", async () => {
      const job = makeJob({ id: "params-check", agent: "custom-agent", message: "do stuff" });
      injectJob(scheduler, job);
      await scheduler.runNow("params-check");

      expect(orchestrator.handleMessage).toHaveBeenCalledWith({
        channelId: "cron",
        userId: "system",
        message: "do stuff",
        agentId: "custom-agent",
        ephemeral: true,
      });
    });
  });
});
