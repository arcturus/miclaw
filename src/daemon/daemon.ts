#!/usr/bin/env tsx
// Daemon process — manages multiple miclaw instances via Unix socket
import { createServer, type Server, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";
import {
  MICLAW_HOME,
  DAEMON_STATE_PATH,
  DAEMON_SOCKET_PATH,
  DAEMON_LOGS_DIR,
  type DaemonState,
  type DaemonCommand,
  type DaemonResponse,
  type ManagedInstance,
  type InstanceStatus,
} from "./types.js";
import { getWorkspace, listWorkspaces } from "./workspace.js";

interface LiveInstance {
  name: string;
  pid: number;
  status: "running" | "stopping";
  startedAt: string;
  webPort: number;
  workspacePath: string;
  child: ChildProcess;
}

class MiclawDaemon {
  private instances = new Map<string, LiveInstance>();
  private server: Server | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    mkdirSync(MICLAW_HOME, { recursive: true });
    mkdirSync(DAEMON_LOGS_DIR, { recursive: true });

    // Clean up stale socket
    if (existsSync(DAEMON_SOCKET_PATH)) {
      unlinkSync(DAEMON_SOCKET_PATH);
    }

    this.server = createServer((socket) => this.handleConnection(socket));

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(DAEMON_SOCKET_PATH, () => resolve());
      this.server!.on("error", reject);
    });

    // Write daemon state
    const state: DaemonState = {
      pid: process.pid,
      socketPath: DAEMON_SOCKET_PATH,
      startedAt: new Date().toISOString(),
      version: "0.1.0",
    };
    writeFileSync(DAEMON_STATE_PATH, JSON.stringify(state, null, 2) + "\n");

    // Health check every 30s
    this.healthTimer = setInterval(() => this.healthCheck(), 30_000);

    console.log(`[daemon] Started (pid=${process.pid})`);

    // Graceful shutdown
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
  }

  async stop(): Promise<void> {
    console.log("[daemon] Stopping all instances...");

    // Stop all instances
    const stopPromises = [...this.instances.keys()].map((name) =>
      this.stopInstance(name),
    );
    await Promise.allSettled(stopPromises);

    // Clean up
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (existsSync(DAEMON_SOCKET_PATH)) unlinkSync(DAEMON_SOCKET_PATH);
    if (existsSync(DAEMON_STATE_PATH)) unlinkSync(DAEMON_STATE_PATH);

    console.log("[daemon] Stopped");
    process.exit(0);
  }

  async startInstance(name: string): Promise<InstanceStatus> {
    if (this.instances.has(name)) {
      const inst = this.instances.get(name)!;
      return this.toStatus(inst);
    }

    const workspace = getWorkspace(name);
    if (!workspace) {
      throw new Error(`Workspace "${name}" not found. Run: miclaw init ${name}`);
    }

    const configPath = path.join(workspace.path, workspace.configFile);
    if (!existsSync(configPath)) {
      throw new Error(`Config not found at ${configPath}`);
    }

    // Find the miclaw index.ts entry point
    const indexPath = path.join(
      path.dirname(path.dirname(new URL(import.meta.url).pathname)),
      "index.ts",
    );

    // Set up log files
    const stdoutLog = path.join(DAEMON_LOGS_DIR, `${name}.stdout.log`);
    const stderrLog = path.join(DAEMON_LOGS_DIR, `${name}.stderr.log`);
    const stdoutStream = createWriteStream(stdoutLog, { flags: "a" });
    const stderrStream = createWriteStream(stderrLog, { flags: "a" });

    const child = spawn("tsx", [indexPath, configPath], {
      cwd: workspace.path,
      env: { ...process.env, MICLAW_MANAGED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    child.stdout!.pipe(stdoutStream);
    child.stderr!.pipe(stderrStream);

    const instance: LiveInstance = {
      name,
      pid: child.pid!,
      status: "running",
      startedAt: new Date().toISOString(),
      webPort: workspace.webPort,
      workspacePath: workspace.path,
      child,
    };

    child.on("exit", (code, signal) => {
      console.log(`[daemon] Instance "${name}" exited (code=${code}, signal=${signal})`);
      this.instances.delete(name);
      stdoutStream.close();
      stderrStream.close();
    });

    this.instances.set(name, instance);
    console.log(`[daemon] Started "${name}" (pid=${child.pid}, port=${workspace.webPort})`);

    return this.toStatus(instance);
  }

  async stopInstance(name: string): Promise<void> {
    const instance = this.instances.get(name);
    if (!instance) {
      throw new Error(`Instance "${name}" is not running`);
    }

    instance.status = "stopping";

    // SIGTERM first, SIGKILL after 5s
    instance.child.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.instances.has(name)) {
          console.log(`[daemon] Force-killing "${name}"`);
          instance.child.kill("SIGKILL");
        }
        resolve();
      }, 5000);

      instance.child.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.instances.delete(name);
    console.log(`[daemon] Stopped "${name}"`);
  }

  getInstanceStatuses(): InstanceStatus[] {
    const workspaces = listWorkspaces();
    return workspaces.map((ws) => {
      const live = this.instances.get(ws.name);
      if (live) {
        return this.toStatus(live);
      }
      return {
        name: ws.name,
        pid: null,
        status: "stopped" as const,
        startedAt: null,
        webPort: ws.webPort,
        workspacePath: ws.path,
        uptime: null,
      };
    });
  }

  private toStatus(inst: LiveInstance): InstanceStatus {
    const uptime = Math.floor(
      (Date.now() - new Date(inst.startedAt).getTime()) / 1000,
    );
    return {
      name: inst.name,
      pid: inst.pid,
      status: inst.status,
      startedAt: inst.startedAt,
      webPort: inst.webPort,
      workspacePath: inst.workspacePath,
      uptime,
    };
  }

  private healthCheck(): void {
    for (const [name, instance] of this.instances) {
      try {
        process.kill(instance.pid, 0); // signal 0 = check alive
      } catch {
        console.log(`[daemon] Instance "${name}" (pid=${instance.pid}) is no longer running`);
        this.instances.delete(name);
      }
    }
  }

  private handleConnection(socket: Socket): void {
    let buffer = "";

    socket.on("data", (data) => {
      buffer += data.toString();

      // Process complete JSON messages (newline-delimited)
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        this.handleMessage(line)
          .then((response) => {
            socket.write(JSON.stringify(response) + "\n");
          })
          .catch((err) => {
            socket.write(
              JSON.stringify({ ok: false, error: String(err) }) + "\n",
            );
          });
      }
    });
  }

  private async handleMessage(raw: string): Promise<DaemonResponse> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: "Invalid JSON" };
    }

    if (!parsed || typeof parsed !== "object" || !("type" in parsed) || typeof (parsed as any).type !== "string") {
      return { ok: false, error: "Invalid command: missing 'type' field" };
    }

    const cmd = parsed as DaemonCommand;

    try {
      switch (cmd.type) {
        case "start": {
          const status = await this.startInstance(cmd.name);
          return { ok: true, data: status };
        }
        case "stop": {
          await this.stopInstance(cmd.name);
          return { ok: true };
        }
        case "restart": {
          try {
            await this.stopInstance(cmd.name);
          } catch {
            // may not be running
          }
          const status = await this.startInstance(cmd.name);
          return { ok: true, data: status };
        }
        case "list": {
          const statuses = this.getInstanceStatuses();
          return { ok: true, data: statuses };
        }
        case "status": {
          const live = this.instances.get(cmd.name);
          if (live) {
            return { ok: true, data: this.toStatus(live) };
          }
          const ws = getWorkspace(cmd.name);
          if (ws) {
            return {
              ok: true,
              data: {
                name: ws.name,
                pid: null,
                status: "stopped",
                startedAt: null,
                webPort: ws.webPort,
                workspacePath: ws.path,
                uptime: null,
              },
            };
          }
          return { ok: false, error: `Workspace "${cmd.name}" not found` };
        }
        case "kill": {
          // Stop all then exit daemon
          setTimeout(() => this.stop(), 100);
          return { ok: true };
        }
        default:
          return { ok: false, error: `Unknown command type` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ─── Entry point ────────────────────────────────────────────

const daemon = new MiclawDaemon();
daemon.start().catch((err) => {
  console.error(`[daemon] Fatal: ${err}`);
  process.exit(1);
});
