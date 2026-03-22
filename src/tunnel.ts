// Layer 3: Tunnel — manages cloudflared subprocess for external access
import { spawn, type ChildProcess, execFileSync } from "node:child_process";

export interface TunnelConfig {
  enabled: boolean;
  /** "quick" = free ephemeral URL (no account needed), "named" = persistent hostname */
  mode: "quick" | "named";
  /** For named tunnels: the tunnel name registered with `cloudflared tunnel create` */
  tunnelName?: string;
  /** For named tunnels: path to credentials JSON file */
  credentialsFile?: string;
  /** For named tunnels: public hostname (e.g. "miclaw.example.com") */
  hostname?: string;
  /** Protocol for the local origin server. Default: "http" */
  protocol?: "http" | "https";
  /** Port of the local web server to tunnel to. Inferred from web channel config if omitted. */
  port?: number;
  /** Host of the local web server. Default: "localhost" */
  host?: string;
  /** Extra args passed to cloudflared. */
  extraArgs?: string[];
}

export interface TunnelInfo {
  url: string;
  mode: "quick" | "named";
  pid: number;
}

export class CloudflareTunnel {
  private process: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private config: TunnelConfig;
  private originUrl: string;

  constructor(config: TunnelConfig, webPort: number, webHost: string = "localhost") {
    this.config = config;
    const protocol = config.protocol ?? "http";
    const host = config.host ?? webHost;
    const port = config.port ?? webPort;
    this.originUrl = `${protocol}://${host}:${port}`;
  }

  /** Check that cloudflared binary is available */
  static isAvailable(): boolean {
    try {
      execFileSync("cloudflared", ["--version"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  async start(): Promise<TunnelInfo> {
    if (this.process) {
      throw new Error("Tunnel already running");
    }

    if (!CloudflareTunnel.isAvailable()) {
      throw new Error(
        "cloudflared is not installed or not in PATH. " +
        "Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
      );
    }

    const args = this.buildArgs();
    console.log(`[tunnel] Starting cloudflared ${this.config.mode} tunnel → ${this.originUrl}`);

    return new Promise<TunnelInfo>((resolve, reject) => {
      const child = spawn("cloudflared", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.process = child;

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          // For named tunnels, URL is known ahead of time
          if (this.config.mode === "named" && this.config.hostname) {
            this.tunnelUrl = `https://${this.config.hostname}`;
            resolve({ url: this.tunnelUrl, mode: "named", pid: child.pid! });
          } else {
            reject(new Error("Timed out waiting for tunnel URL (30s)"));
          }
        }
      }, 30_000);

      const handleOutput = (data: Buffer) => {
        const line = data.toString();
        // cloudflared logs the URL to stderr in both quick and named modes
        const urlMatch = line.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (urlMatch && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          this.tunnelUrl = urlMatch[0];
          console.log(`[tunnel] Tunnel active: ${this.tunnelUrl}`);
          resolve({ url: this.tunnelUrl, mode: this.config.mode, pid: child.pid! });
        }

        // For named tunnels, look for the connection registered message
        if (this.config.mode === "named" && !resolved && /Registered tunnel connection/.test(line)) {
          resolved = true;
          clearTimeout(timeout);
          this.tunnelUrl = `https://${this.config.hostname}`;
          console.log(`[tunnel] Named tunnel active: ${this.tunnelUrl}`);
          resolve({ url: this.tunnelUrl, mode: "named", pid: child.pid! });
        }

        // Log cloudflared output for debugging (strip trailing newline)
        const trimmed = line.trimEnd();
        if (trimmed) {
          console.log(`[tunnel] ${trimmed}`);
        }
      };

      child.stdout?.on("data", handleOutput);
      child.stderr?.on("data", handleOutput);

      child.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Failed to start cloudflared: ${err.message}`));
        }
      });

      child.on("close", (code) => {
        this.process = null;
        this.tunnelUrl = null;
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`cloudflared exited with code ${code} before tunnel was established`));
        } else {
          console.log(`[tunnel] cloudflared exited with code ${code}`);
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    console.log("[tunnel] Stopping cloudflared...");
    const child = this.process;
    this.process = null;
    this.tunnelUrl = null;

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000);

      child.on("close", () => {
        clearTimeout(timeout);
        resolve();
      });

      child.kill("SIGTERM");
    });
  }

  getUrl(): string | null {
    return this.tunnelUrl;
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  private buildArgs(): string[] {
    if (this.config.mode === "quick") {
      return [
        "tunnel",
        "--url", this.originUrl,
        ...(this.config.extraArgs ?? []),
      ];
    }

    // Named tunnel mode
    const args = ["tunnel", "run"];

    if (this.config.credentialsFile) {
      args.push("--credentials-file", this.config.credentialsFile);
    }

    if (this.config.hostname) {
      args.push("--url", this.originUrl);
    }

    if (this.config.extraArgs) {
      args.push(...this.config.extraArgs);
    }

    if (this.config.tunnelName) {
      args.push(this.config.tunnelName);
    }

    return args;
  }
}
