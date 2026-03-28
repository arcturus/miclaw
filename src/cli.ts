#!/usr/bin/env tsx
// CLI entry point — manages miclaw daemon and workspaces
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { initWorkspace, getWorkspace, listWorkspaces } from "./daemon/workspace.js";
import { DaemonClient } from "./daemon/client.js";
import { DAEMON_LOGS_DIR, type InstanceStatus } from "./daemon/types.js";

// ─── Argument Parsing ───────────────────────────────────────

const USAGE = `
\x1b[1mmiclaw\x1b[0m — daemon manager for miclaw instances

Usage:
  miclaw init <name> [--path <dir>]    Create a new workspace
  miclaw start <name> [--foreground]   Start an instance
  miclaw stop <name>                   Stop a running instance
  miclaw restart <name>                Restart an instance
  miclaw list                          List all instances
  miclaw status <name>                 Show instance details
  miclaw logs <name> [--follow]        View instance logs
  miclaw chat <name>                   Interactive chat via web API
  miclaw kill                          Stop all instances and daemon
  miclaw help                          Show this help
`;

async function main() {
  const command = process.argv[2];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case "init":
      return cmdInit();
    case "start":
      return cmdStart();
    case "stop":
      return cmdStop();
    case "restart":
      return cmdRestart();
    case "list":
    case "ls":
      return cmdList();
    case "status":
      return cmdStatus();
    case "logs":
    case "log":
      return cmdLogs();
    case "chat":
      return cmdChat();
    case "kill":
      return cmdKill();
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

// ─── Commands ───────────────────────────────────────────────

async function cmdInit() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      path: { type: "string" },
    },
    allowPositionals: true,
  });

  const name = positionals[0];
  if (!name) {
    console.error("Usage: miclaw init <name> [--path <dir>]");
    process.exit(1);
  }

  try {
    const entry = initWorkspace(name, { path: values.path });
    console.log(`\x1b[32m✓\x1b[0m Workspace "${name}" created`);
    console.log(`  Path: ${entry.path}`);
    console.log(`  Port: ${entry.webPort}`);
    console.log(`\nNext: \x1b[1mmiclaw start ${name}\x1b[0m`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function cmdStart() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      foreground: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const name = positionals[0];
  if (!name) {
    console.error("Usage: miclaw start <name> [--foreground]");
    process.exit(1);
  }

  if (values.foreground) {
    return cmdStartForeground(name);
  }

  const client = new DaemonClient();
  try {
    const resp = await client.request({ type: "start", name });
    if (!resp.ok) {
      console.error(`Error: ${resp.error}`);
      process.exit(1);
    }
    const status = resp.data as InstanceStatus;
    console.log(`\x1b[32m✓\x1b[0m Started "${name}" (pid=${status.pid}, port=${status.webPort})`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function cmdStartForeground(name: string) {
  const workspace = getWorkspace(name);
  if (!workspace) {
    console.error(`Workspace "${name}" not found. Run: miclaw init ${name}`);
    process.exit(1);
  }

  const configPath = path.join(workspace.path, workspace.configFile);
  const indexPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "index.ts",
  );

  const { spawn } = await import("node:child_process");
  const child = spawn("tsx", [indexPath, configPath], {
    cwd: workspace.path,
    stdio: "inherit",
    env: { ...process.env, MICLAW_MANAGED: "1" },
  });

  child.on("exit", (code) => process.exit(code ?? 0));

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

async function cmdStop() {
  const name = process.argv[3];
  if (!name) {
    console.error("Usage: miclaw stop <name>");
    process.exit(1);
  }

  const client = new DaemonClient();
  try {
    const resp = await client.request({ type: "stop", name });
    if (!resp.ok) {
      console.error(`Error: ${resp.error}`);
      process.exit(1);
    }
    console.log(`\x1b[32m✓\x1b[0m Stopped "${name}"`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function cmdRestart() {
  const name = process.argv[3];
  if (!name) {
    console.error("Usage: miclaw restart <name>");
    process.exit(1);
  }

  const client = new DaemonClient();
  try {
    const resp = await client.request({ type: "restart", name });
    if (!resp.ok) {
      console.error(`Error: ${resp.error}`);
      process.exit(1);
    }
    const status = resp.data as InstanceStatus;
    console.log(`\x1b[32m✓\x1b[0m Restarted "${name}" (pid=${status.pid}, port=${status.webPort})`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function cmdList() {
  const client = new DaemonClient();

  // If daemon is not running, just show workspaces from registry
  if (!client.isDaemonRunning()) {
    const workspaces = listWorkspaces();
    if (workspaces.length === 0) {
      console.log("No workspaces. Create one with: miclaw init <name>");
      return;
    }
    printStatusTable(
      workspaces.map((ws) => ({
        name: ws.name,
        pid: null,
        status: "stopped" as const,
        startedAt: null,
        webPort: ws.webPort,
        workspacePath: ws.path,
        uptime: null,
      })),
    );
    return;
  }

  try {
    const resp = await client.request({ type: "list" });
    if (!resp.ok) {
      console.error(`Error: ${resp.error}`);
      process.exit(1);
    }
    const statuses = resp.data as InstanceStatus[];
    if (statuses.length === 0) {
      console.log("No workspaces. Create one with: miclaw init <name>");
      return;
    }
    printStatusTable(statuses);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function cmdStatus() {
  const name = process.argv[3];
  if (!name) {
    console.error("Usage: miclaw status <name>");
    process.exit(1);
  }

  const client = new DaemonClient();
  try {
    const resp = await client.request({ type: "status", name });
    if (!resp.ok) {
      console.error(`Error: ${resp.error}`);
      process.exit(1);
    }
    const s = resp.data as InstanceStatus;
    console.log(`\x1b[1m${s.name}\x1b[0m`);
    console.log(`  Status:    ${colorStatus(s.status)}`);
    console.log(`  PID:       ${s.pid ?? "-"}`);
    console.log(`  Port:      ${s.webPort}`);
    console.log(`  Path:      ${s.workspacePath}`);
    console.log(`  Uptime:    ${s.uptime !== null ? formatUptime(s.uptime) : "-"}`);
    console.log(`  Started:   ${s.startedAt ?? "-"}`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function cmdLogs() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      follow: { type: "boolean", short: "f", default: false },
      lines: { type: "string", short: "n", default: "50" },
    },
    allowPositionals: true,
  });

  const name = positionals[0];
  if (!name) {
    console.error("Usage: miclaw logs <name> [--follow] [--lines <n>]");
    process.exit(1);
  }

  const logFile = path.join(DAEMON_LOGS_DIR, `${name}.stdout.log`);
  if (!existsSync(logFile)) {
    console.error(`No logs found for "${name}". Is it running?`);
    process.exit(1);
  }

  const numLines = parseInt(values.lines!, 10) || 50;

  // Read last N lines
  const content = readFileSync(logFile, "utf-8");
  const lines = content.split("\n");
  const tail = lines.slice(-numLines).join("\n");
  process.stdout.write(tail);

  if (values.follow) {
    // Follow mode: watch for changes
    const { watch, statSync, createReadStream } = await import("node:fs");
    let lastSize = Buffer.byteLength(content, "utf-8");

    const watcher = watch(logFile, () => {
      try {
        const stat = statSync(logFile);
        if (stat.size > lastSize) {
          const stream = createReadStream(logFile, { start: lastSize });
          stream.pipe(process.stdout);
          lastSize = stat.size;
        }
      } catch {
        // file may have been rotated
      }
    });

    // Keep process alive until SIGINT
    process.on("SIGINT", () => {
      watcher.close();
      process.exit(0);
    });

    // Prevent exit
    await new Promise(() => {});
  }
}

async function cmdChat() {
  const name = process.argv[3];
  if (!name) {
    console.error("Usage: miclaw chat <name>");
    process.exit(1);
  }

  const workspace = getWorkspace(name);
  if (!workspace) {
    console.error(`Workspace "${name}" not found.`);
    process.exit(1);
  }

  // Read host/port from the workspace's actual config (may have been changed)
  let webHost = "127.0.0.1";
  let webPort = workspace.webPort;
  const configPath = path.join(workspace.path, workspace.configFile);
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      if (cfg.channels?.web?.host) webHost = cfg.channels.web.host;
      if (cfg.channels?.web?.port) webPort = cfg.channels.web.port;
    } catch {
      // fall back to registry values
    }
  }

  // Check if the instance is actually running by pinging health endpoint
  const baseUrl = `http://${webHost}:${webPort}`;
  try {
    const resp = await fetch(`${baseUrl}/api/health`);
    if (!resp.ok) throw new Error("not healthy");
  } catch {
    console.error(`Instance "${name}" does not appear to be running on port ${webPort}.`);
    console.error(`Start it with: miclaw start ${name}`);
    process.exit(1);
  }

  console.log(`\x1b[1mConnected to "${name}"\x1b[0m (port ${webPort})`);
  console.log("Type a message to chat. Ctrl+C to exit.\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const askQuestion = () => {
    rl.question("you> ", async (input) => {
      const message = input.trim();
      if (!message) {
        askQuestion();
        return;
      }

      if (message === "/quit" || message === "/exit") {
        rl.close();
        process.exit(0);
      }

      console.log("\n⏳ Thinking...\n");

      try {
        const resp = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            userId: "daemon-cli",
          }),
        });

        if (!resp.ok) {
          const text = await resp.text();
          console.error(`Error (${resp.status}): ${text}\n`);
          askQuestion();
          return;
        }

        const data = (await resp.json()) as { result: string; cost?: number; durationMs?: number };
        console.log(`${data.result}\n`);
        if (data.cost) {
          console.log(`  [$${data.cost.toFixed(4)} | ${((data.durationMs ?? 0) / 1000).toFixed(1)}s]\n`);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}\n`);
      }

      askQuestion();
    });
  };

  askQuestion();
}

async function cmdKill() {
  const client = new DaemonClient();
  if (!client.isDaemonRunning()) {
    console.log("Daemon is not running.");
    return;
  }

  try {
    await client.request({ type: "kill" });
    console.log("\x1b[32m✓\x1b[0m Daemon and all instances stopped.");
  } catch {
    // Daemon exits during kill, connection may close
    console.log("\x1b[32m✓\x1b[0m Daemon and all instances stopped.");
  }
}

// ─── Helpers ────────────────────────────────────────────────

function printStatusTable(statuses: InstanceStatus[]): void {
  // Header
  const nameW = Math.max(12, ...statuses.map((s) => s.name.length)) + 2;
  const header = [
    "NAME".padEnd(nameW),
    "STATUS".padEnd(10),
    "PID".padEnd(8),
    "PORT".padEnd(7),
    "UPTIME",
  ].join("");

  console.log(`\x1b[1m${header}\x1b[0m`);

  for (const s of statuses) {
    const line = [
      s.name.padEnd(nameW),
      colorStatus(s.status).padEnd(10 + 9), // +9 for ANSI escape codes
      (s.pid?.toString() ?? "-").padEnd(8),
      s.webPort.toString().padEnd(7),
      s.uptime !== null ? formatUptime(s.uptime) : "-",
    ].join("");
    console.log(line);
  }
}

function colorStatus(status: string): string {
  switch (status) {
    case "running":
      return "\x1b[32mrunning\x1b[0m";
    case "stopped":
      return "\x1b[90mstopped\x1b[0m";
    case "crashed":
      return "\x1b[31mcrashed\x1b[0m";
    default:
      return status;
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ─── Run ────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
