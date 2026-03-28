// Daemon client — connects to daemon via Unix socket, auto-starts if needed
import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, openSync } from "node:fs";
import path from "node:path";
import {
  DAEMON_STATE_PATH,
  DAEMON_SOCKET_PATH,
  DAEMON_LOGS_DIR,
  getTsxBin,
  type DaemonState,
  type DaemonCommand,
  type DaemonResponse,
} from "./types.js";

export class DaemonClient {
  private socket: Socket | null = null;

  /** Check if the daemon process is alive */
  isDaemonRunning(): boolean {
    if (!existsSync(DAEMON_STATE_PATH)) return false;
    try {
      const state: DaemonState = JSON.parse(
        readFileSync(DAEMON_STATE_PATH, "utf-8"),
      );
      process.kill(state.pid, 0); // signal 0 = check alive
      return true;
    } catch {
      return false;
    }
  }

  /** Start the daemon as a detached background process */
  async ensureDaemon(): Promise<void> {
    if (this.isDaemonRunning()) return;

    const daemonScript = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "daemon.ts",
    );

    const logPath = path.join(DAEMON_LOGS_DIR, "daemon.log");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(DAEMON_LOGS_DIR, { recursive: true });
    const logFd = openSync(logPath, "a");

    const child = spawn(getTsxBin(), [daemonScript], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, MICLAW_DAEMON: "1" },
    });
    child.unref();

    // Wait for socket to appear (poll up to 5s)
    const maxWait = 5000;
    const interval = 100;
    let waited = 0;
    while (waited < maxWait) {
      await new Promise((r) => setTimeout(r, interval));
      waited += interval;
      if (existsSync(DAEMON_SOCKET_PATH)) {
        // Give it a moment to bind
        await new Promise((r) => setTimeout(r, 200));
        return;
      }
    }
    throw new Error("Daemon failed to start within 5 seconds. Check ~/.miclaw/logs/daemon.log");
  }

  /** Connect to the daemon socket */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = connect(DAEMON_SOCKET_PATH, () => resolve());
      this.socket.on("error", (err) => {
        reject(new Error(`Cannot connect to daemon: ${err.message}`));
      });
    });
  }

  /** Send a command and wait for response */
  async send(cmd: DaemonCommand): Promise<DaemonResponse> {
    if (!this.socket) {
      throw new Error("Not connected to daemon");
    }

    return new Promise((resolve, reject) => {
      let buffer = "";

      const onData = (data: Buffer) => {
        buffer += data.toString();
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx);
          this.socket!.removeListener("data", onData);
          try {
            resolve(JSON.parse(line));
          } catch {
            reject(new Error("Invalid response from daemon"));
          }
        }
      };

      this.socket!.on("data", onData);
      this.socket!.write(JSON.stringify(cmd) + "\n");

      // Timeout after 30s
      setTimeout(() => {
        this.socket?.removeListener("data", onData);
        reject(new Error("Daemon response timeout"));
      }, 30_000);
    });
  }

  /** Ensure daemon is running, connect, send command, close */
  async request(cmd: DaemonCommand): Promise<DaemonResponse> {
    await this.ensureDaemon();
    await this.connect();
    try {
      return await this.send(cmd);
    } finally {
      this.close();
    }
  }

  close(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
  }
}
