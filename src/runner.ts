// Layer 1: ClaudeRunner — wraps `claude -p` subprocess
import { spawn } from "node:child_process";
import type { ClaudeRunnerOptions, ClaudeRunnerResult, ClaudeJsonOutput } from "./types.js";
import { RunnerError } from "./types.js";

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

/** Construct a sanitized environment for claude subprocesses */
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const BLOCKED = [
    "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    "DATABASE_URL", "DB_PASSWORD",
    "GITHUB_TOKEN", "GH_TOKEN",
    "MIKECLAW_WEB_API_KEY",
  ];
  for (const key of BLOCKED) {
    delete env[key];
  }
  return env;
}

/** Parse JSON output from claude -p, handling version differences gracefully */
function parseClaudeOutput(raw: string): ClaudeJsonOutput | null {
  try {
    const json = JSON.parse(raw);
    if (typeof json !== "object" || json === null) return null;
    return {
      type: json.type ?? "result",
      subtype: json.subtype ?? "success",
      is_error: Boolean(json.is_error),
      result: typeof json.result === "string" ? json.result : String(json.result ?? ""),
      session_id: typeof json.session_id === "string" ? json.session_id : "",
      cost_usd: typeof json.cost_usd === "number" ? json.cost_usd : undefined,
      duration_ms: typeof json.duration_ms === "number" ? json.duration_ms : undefined,
      duration_api_ms: typeof json.duration_api_ms === "number" ? json.duration_api_ms : undefined,
      num_turns: typeof json.num_turns === "number" ? json.num_turns : undefined,
    };
  } catch {
    return null;
  }
}

export class ClaudeRunner {
  async run(opts: ClaudeRunnerOptions): Promise<ClaudeRunnerResult> {
    const startTime = Date.now();
    const args: string[] = ["-p", "--output-format", "json"];

    // System prompt injection
    if (opts.appendSystemPrompt) {
      args.push("--append-system-prompt", opts.appendSystemPrompt);
    } else if (opts.systemPrompt) {
      args.push("--system-prompt", opts.systemPrompt);
    }

    // Session resumption
    if (opts.resume) {
      args.push("--resume", opts.resume);
    }

    // Model
    if (opts.model) {
      args.push("--model", opts.model);
    }

    // Allowed tools
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      for (const tool of opts.allowedTools) {
        args.push("--allowedTools", tool);
      }
    }

    // MCP config
    if (opts.mcpConfig) {
      args.push("--mcp-config", opts.mcpConfig);
    }

    // Permission mode
    if (opts.permissionMode) {
      args.push("--permission-mode", opts.permissionMode);
    }

    // User message (positional argument)
    args.push(opts.message);

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<ClaudeRunnerResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;

      const child = spawn("claude", args, {
        cwd: opts.cwd ?? process.cwd(),
        env: sanitizedEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });

      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({
          result: "",
          sessionId: "",
          ok: false,
          error: `Failed to spawn claude: ${err.message}`,
          durationMs: Date.now() - startTime,
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        const durationMs = Date.now() - startTime;

        if (killed) {
          resolve({
            result: "",
            sessionId: "",
            ok: false,
            error: `claude -p timed out after ${timeoutMs}ms`,
            durationMs,
          });
          return;
        }

        if (code !== 0 && code !== null) {
          // Try to parse output anyway — claude sometimes exits non-zero but still produces JSON
          const parsed = parseClaudeOutput(stdout);
          if (parsed) {
            resolve({
              result: parsed.result,
              sessionId: parsed.session_id,
              ok: !parsed.is_error,
              error: parsed.is_error ? `Claude error (${parsed.subtype}): ${parsed.result}` : undefined,
              cost: parsed.cost_usd,
              rawOutput: parsed,
              durationMs,
            });
            return;
          }

          resolve({
            result: "",
            sessionId: "",
            ok: false,
            error: `claude exited with code ${code}. stderr: ${stderr.slice(0, 500)}`,
            durationMs,
          });
          return;
        }

        const parsed = parseClaudeOutput(stdout);
        if (!parsed) {
          resolve({
            result: stdout.trim(),
            sessionId: "",
            ok: false,
            error: `Failed to parse claude JSON output: ${stdout.slice(0, 200)}`,
            durationMs,
          });
          return;
        }

        resolve({
          result: parsed.result,
          sessionId: parsed.session_id,
          ok: !parsed.is_error,
          error: parsed.is_error ? `Claude error (${parsed.subtype}): ${parsed.result}` : undefined,
          cost: parsed.cost_usd,
          rawOutput: parsed,
          durationMs,
        });
      });

      // Close stdin immediately — we don't send input via stdin
      child.stdin.end();
    });
  }
}

/** Process pool to limit concurrent claude -p processes */
export class ProcessPool {
  private active = 0;
  private queue: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  constructor(
    private maxConcurrent: number = 5,
    private maxQueueDepth: number = 20,
    private queueTimeoutMs: number = 30_000,
  ) {}

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    if (this.queue.length >= this.maxQueueDepth) {
      throw new RunnerError("Service at capacity", "RUNNER_SPAWN");
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((e) => e.resolve === resolve);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new RunnerError("Queue timeout", "RUNNER_TIMEOUT"));
      }, this.queueTimeoutMs);
      this.queue.push({
        resolve: () => { clearTimeout(timer); this.active++; resolve(); },
        reject,
      });
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next.resolve();
  }
}
