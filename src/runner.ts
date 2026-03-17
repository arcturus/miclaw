// Layer 1: ClaudeRunner — wraps `claude -p` subprocess
// Uses --output-format stream-json (NDJSON) to capture ALL assistant text,
// including text between tool calls that --output-format json drops.
import { spawn } from "node:child_process";
import type { ClaudeRunnerOptions, ClaudeRunnerResult, ClaudeJsonOutput } from "./types.js";
import { RunnerError } from "./types.js";

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

let runSeq = 0;

function redact(args: string[]): string[] {
  return args.map((a, i) => {
    const prev = args[i - 1];
    if (prev === "--system-prompt" || prev === "--append-system-prompt") {
      return `<${a.length} chars>`;
    }
    if (i === args.length - 1 && a.length > 200) {
      return `${a.slice(0, 100)}...<${a.length} chars>`;
    }
    return a;
  });
}

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

/**
 * Parse NDJSON stream from `claude -p --output-format stream-json`.
 *
 * Each line is one of:
 *   {"type":"system", ...}          — system info (session_id, model, etc.)
 *   {"type":"assistant", "message":{...}, "content_block":{...}} — text/tool blocks
 *   {"type":"result", ...}          — final summary with cost, turns, etc.
 *
 * We accumulate all assistant text blocks and merge with the result event.
 */
export function parseStreamOutput(raw: string, rid: number): {
  result: ClaudeJsonOutput | null;
  accumulatedText: string;
  toolUses: string[];
} {
  const lines = raw.split("\n").filter(Boolean);
  let resultEvent: any = null;
  const textParts: string[] = [];
  const toolUses: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    try {
      const event = JSON.parse(line);
      const etype = event.type;

      if (etype === "assistant" && event.message?.content) {
        // Claude Code stream-json format: assistant events have message.content[]
        const content = event.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && typeof block.text === "string") {
              textParts.push(block.text);
              console.log(`[runner:${rid}]   ◇ text: ${block.text.slice(0, 120).replace(/\n/g, "\\n")}${block.text.length > 120 ? "..." : ""}`);
            } else if (block.type === "tool_use") {
              toolUses.push(block.name ?? "unknown");
              const inputPreview = JSON.stringify(block.input ?? {}).slice(0, 100);
              console.log(`[runner:${rid}]   ◆ tool_use: ${block.name}(${inputPreview})`);
            }
          }
        }
      } else if (etype === "user" && event.tool_use_result) {
        const tr = event.tool_use_result;
        const isErr = tr.is_error ? " [ERROR]" : "";
        const preview = typeof tr.content === "string"
          ? tr.content.slice(0, 80)
          : JSON.stringify(tr.content ?? "").slice(0, 80);
        console.log(`[runner:${rid}]   ◇ tool_result${isErr}: ${preview.replace(/\n/g, "\\n")}`);
      } else if (etype === "user" && event.message?.content) {
        // Tool results also come as user messages with content array
        const content = event.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              const isErr = block.is_error ? " [ERROR]" : "";
              const preview = typeof block.content === "string"
                ? block.content.slice(0, 80)
                : JSON.stringify(block.content ?? "").slice(0, 80);
              console.log(`[runner:${rid}]   ◇ tool_result${isErr}: ${preview.replace(/\n/g, "\\n")}`);
            }
          }
        }
      } else if (etype === "result") {
        resultEvent = event;
        console.log(`[runner:${rid}]   raw result keys: [${Object.keys(event).join(", ")}]`);
      } else if (etype === "system") {
        console.log(`[runner:${rid}]   system: ${event.subtype ?? "init"} session=${event.session_id ?? "?"}`);
      }
      // Silently skip: rate_limit_event
    } catch {
      // Skip malformed lines
    }
  }

  if (!resultEvent) {
    return { result: null, accumulatedText: textParts.join("\n"), toolUses };
  }

  const cost = typeof resultEvent.total_cost_usd === "number"
    ? resultEvent.total_cost_usd
    : typeof resultEvent.cost_usd === "number"
      ? resultEvent.cost_usd
      : undefined;

  const parsed: ClaudeJsonOutput = {
    type: "result",
    subtype: resultEvent.subtype ?? "success",
    is_error: Boolean(resultEvent.is_error),
    result: typeof resultEvent.result === "string" ? resultEvent.result : "",
    session_id: typeof resultEvent.session_id === "string" ? resultEvent.session_id : "",
    cost_usd: cost,
    duration_ms: typeof resultEvent.duration_ms === "number" ? resultEvent.duration_ms : undefined,
    duration_api_ms: typeof resultEvent.duration_api_ms === "number" ? resultEvent.duration_api_ms : undefined,
    num_turns: typeof resultEvent.num_turns === "number" ? resultEvent.num_turns : undefined,
  };

  return { result: parsed, accumulatedText: textParts.join("\n"), toolUses };
}

export class ClaudeRunner {
  async run(opts: ClaudeRunnerOptions): Promise<ClaudeRunnerResult> {
    const rid = ++runSeq;
    const startTime = Date.now();
    const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];

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

    console.log(`[runner:${rid}] ▶ spawn claude ${redact(args).join(" ")}`);
    console.log(`[runner:${rid}]   model=${opts.model ?? "default"} resume=${opts.resume ?? "none"} timeout=${timeoutMs}ms`);
    if (opts.allowedTools?.length) {
      console.log(`[runner:${rid}]   tools=[${opts.allowedTools.join(", ")}]`);
    }
    if (opts.mcpConfig) {
      console.log(`[runner:${rid}]   mcp-config=${opts.mcpConfig}`);
    }

    return new Promise<ClaudeRunnerResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;

      const child = spawn("claude", args, {
        cwd: opts.cwd ?? process.cwd(),
        env: sanitizedEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });

      console.log(`[runner:${rid}]   pid=${child.pid}`);

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
        console.error(`[runner:${rid}] ✗ spawn error: ${err.message}`);
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
          console.warn(`[runner:${rid}] ✗ timeout after ${timeoutMs}ms`);
          resolve({
            result: "",
            sessionId: "",
            ok: false,
            error: `claude -p timed out after ${timeoutMs}ms`,
            durationMs,
          });
          return;
        }

        console.log(`[runner:${rid}]   exit code=${code} duration=${durationMs}ms stdout=${stdout.length}b stderr=${stderr.length}b`);

        // Parse NDJSON stream
        const { result: parsed, accumulatedText, toolUses } = parseStreamOutput(stdout, rid);

        if (code !== 0 && code !== null) {
          if (parsed) {
            console.warn(`[runner:${rid}] ⚠ non-zero exit (${code}) but got result event: ok=${!parsed.is_error} session=${parsed.session_id}`);
            if (stderr) console.warn(`[runner:${rid}]   stderr: ${stderr.slice(0, 300)}`);
            // Use accumulated text if result.result is empty
            const finalText = parsed.result || accumulatedText;
            resolve({
              result: finalText,
              sessionId: parsed.session_id,
              ok: !parsed.is_error,
              error: parsed.is_error ? `Claude error (${parsed.subtype}): ${finalText}` : undefined,
              cost: parsed.cost_usd,
              rawOutput: { ...parsed, result: finalText },
              durationMs,
            });
            return;
          }

          console.error(`[runner:${rid}] ✗ exit code ${code}, no result event. stderr: ${stderr.slice(0, 300)}`);
          // Still try to return accumulated text if we got any
          resolve({
            result: accumulatedText || "",
            sessionId: "",
            ok: false,
            error: `claude exited with code ${code}. stderr: ${stderr.slice(0, 500)}`,
            durationMs,
          });
          return;
        }

        if (!parsed) {
          console.error(`[runner:${rid}] ✗ no result event in stream (${stdout.split("\n").length} lines)`);
          // Return accumulated text even without a result event
          resolve({
            result: accumulatedText || stdout.trim(),
            sessionId: "",
            ok: accumulatedText.length > 0,
            error: accumulatedText.length > 0 ? undefined : `No result event in claude stream output`,
            durationMs,
          });
          return;
        }

        // Use accumulated text from content blocks if result.result is empty
        const finalText = parsed.result || accumulatedText;

        const preview = finalText.slice(0, 120).replace(/\n/g, "\\n");
        console.log(`[runner:${rid}] ◀ ok=${!parsed.is_error} session=${parsed.session_id} cost=$${parsed.cost_usd?.toFixed(4) ?? "?"} turns=${parsed.num_turns ?? "?"} duration=${durationMs}ms`);
        if (toolUses.length > 0) {
          console.log(`[runner:${rid}]   tools used: [${toolUses.join(", ")}]`);
        }
        console.log(`[runner:${rid}]   response (${finalText.length} chars): ${preview}${finalText.length > 120 ? "..." : ""}`);
        if (parsed.result && accumulatedText && parsed.result !== accumulatedText) {
          console.log(`[runner:${rid}]   note: result field=${parsed.result.length}b, accumulated text=${accumulatedText.length}b (used ${parsed.result ? "result" : "accumulated"})`);
        }

        resolve({
          result: finalText,
          sessionId: parsed.session_id,
          ok: !parsed.is_error,
          error: parsed.is_error ? `Claude error (${parsed.subtype}): ${finalText}` : undefined,
          cost: parsed.cost_usd,
          rawOutput: { ...parsed, result: finalText },
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
