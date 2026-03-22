import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter, Readable } from "node:stream";

// Mock child_process
const mockSpawn = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
  execFileSync: (...args: any[]) => mockExecFileSync(...args),
}));

import { CloudflareTunnel, type TunnelConfig } from "../src/tunnel.js";

function createMockProcess(): ChildProcess & { _emit: (stream: "stdout" | "stderr", data: string) => void } {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 12345;
  proc.kill = vi.fn();
  proc.stdin = null;
  proc.stdio = [null, proc.stdout, proc.stderr];
  proc._emit = (stream: "stdout" | "stderr", data: string) => {
    proc[stream].emit("data", Buffer.from(data));
  };
  return proc;
}

describe("CloudflareTunnel.isAvailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when cloudflared is installed", () => {
    mockExecFileSync.mockReturnValue(Buffer.from("cloudflared version 2024.1.0"));
    expect(CloudflareTunnel.isAvailable()).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith("cloudflared", ["--version"], { stdio: "pipe" });
  });

  it("returns false when cloudflared is not installed", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(CloudflareTunnel.isAvailable()).toBe(false);
  });
});

describe("CloudflareTunnel quick mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // cloudflared is available
    mockExecFileSync.mockReturnValue(Buffer.from("cloudflared version 2024.1.0"));
  });

  it("starts a quick tunnel and resolves with URL", async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config: TunnelConfig = { enabled: true, mode: "quick" };
    const tunnel = new CloudflareTunnel(config, 3456);

    const startPromise = tunnel.start();

    // Simulate cloudflared outputting the URL
    mockProc._emit("stderr", "2024/01/01 INF +-----------------------------------------------------------+\n");
    mockProc._emit("stderr", "2024/01/01 INF |  Your quick Tunnel has been created! Visit it at:\n");
    mockProc._emit("stderr", "2024/01/01 INF |  https://random-words-here.trycloudflare.com\n");

    const info = await startPromise;
    expect(info.url).toBe("https://random-words-here.trycloudflare.com");
    expect(info.mode).toBe("quick");
    expect(info.pid).toBe(12345);
    expect(tunnel.isRunning()).toBe(true);
    expect(tunnel.getUrl()).toBe("https://random-words-here.trycloudflare.com");
  });

  it("builds correct args for quick mode", async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config: TunnelConfig = { enabled: true, mode: "quick" };
    const tunnel = new CloudflareTunnel(config, 3456, "127.0.0.1");

    const startPromise = tunnel.start();
    mockProc._emit("stderr", "https://test-url.trycloudflare.com\n");
    await startPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "http://127.0.0.1:3456"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("supports custom protocol and extra args", async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config: TunnelConfig = {
      enabled: true,
      mode: "quick",
      protocol: "https",
      port: 8443,
      host: "localhost",
      extraArgs: ["--no-autoupdate"],
    };
    const tunnel = new CloudflareTunnel(config, 3456);

    const startPromise = tunnel.start();
    mockProc._emit("stderr", "https://test-url.trycloudflare.com\n");
    await startPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "https://localhost:8443", "--no-autoupdate"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("rejects when cloudflared is not available", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const config: TunnelConfig = { enabled: true, mode: "quick" };
    const tunnel = new CloudflareTunnel(config, 3456);
    await expect(tunnel.start()).rejects.toThrow("cloudflared is not installed");
  });

  it("rejects when process exits before URL is found", async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config: TunnelConfig = { enabled: true, mode: "quick" };
    const tunnel = new CloudflareTunnel(config, 3456);

    const startPromise = tunnel.start();
    mockProc.emit("close", 1);

    await expect(startPromise).rejects.toThrow("cloudflared exited with code 1");
    expect(tunnel.isRunning()).toBe(false);
  });

  it("rejects when process emits error", async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config: TunnelConfig = { enabled: true, mode: "quick" };
    const tunnel = new CloudflareTunnel(config, 3456);

    const startPromise = tunnel.start();
    mockProc.emit("error", new Error("spawn ENOENT"));

    await expect(startPromise).rejects.toThrow("Failed to start cloudflared: spawn ENOENT");
  });

  it("throws if start() called while already running", async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config: TunnelConfig = { enabled: true, mode: "quick" };
    const tunnel = new CloudflareTunnel(config, 3456);

    const startPromise = tunnel.start();
    mockProc._emit("stderr", "https://test.trycloudflare.com\n");
    await startPromise;

    await expect(tunnel.start()).rejects.toThrow("Tunnel already running");
  });
});

describe("CloudflareTunnel named mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReturnValue(Buffer.from("cloudflared version 2024.1.0"));
  });

  it("builds correct args for named tunnel", async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config: TunnelConfig = {
      enabled: true,
      mode: "named",
      tunnelName: "my-tunnel",
      credentialsFile: "/home/user/.cloudflared/cert.json",
      hostname: "miclaw.example.com",
    };
    const tunnel = new CloudflareTunnel(config, 3456);

    const startPromise = tunnel.start();
    mockProc._emit("stderr", "INF Registered tunnel connection connIndex=0\n");
    await startPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "cloudflared",
      [
        "tunnel", "run",
        "--credentials-file", "/home/user/.cloudflared/cert.json",
        "--url", "http://localhost:3456",
        "my-tunnel",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("resolves with hostname URL for named tunnels", async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config: TunnelConfig = {
      enabled: true,
      mode: "named",
      tunnelName: "my-tunnel",
      hostname: "miclaw.example.com",
    };
    const tunnel = new CloudflareTunnel(config, 3456);

    const startPromise = tunnel.start();
    mockProc._emit("stderr", "INF Registered tunnel connection connIndex=0\n");

    const info = await startPromise;
    expect(info.url).toBe("https://miclaw.example.com");
    expect(info.mode).toBe("named");
  });
});

describe("CloudflareTunnel stop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReturnValue(Buffer.from("cloudflared version 2024.1.0"));
  });

  it("sends SIGTERM and waits for exit", async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config: TunnelConfig = { enabled: true, mode: "quick" };
    const tunnel = new CloudflareTunnel(config, 3456);

    const startPromise = tunnel.start();
    mockProc._emit("stderr", "https://test.trycloudflare.com\n");
    await startPromise;

    const stopPromise = tunnel.stop();
    expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");

    // Simulate process exiting
    mockProc.emit("close", 0);
    await stopPromise;

    expect(tunnel.isRunning()).toBe(false);
    expect(tunnel.getUrl()).toBeNull();
  });

  it("stop() is a no-op when not running", async () => {
    const config: TunnelConfig = { enabled: true, mode: "quick" };
    const tunnel = new CloudflareTunnel(config, 3456);
    await tunnel.stop(); // should not throw
  });

  it("clears URL when process exits on its own", async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config: TunnelConfig = { enabled: true, mode: "quick" };
    const tunnel = new CloudflareTunnel(config, 3456);

    const startPromise = tunnel.start();
    mockProc._emit("stderr", "https://test.trycloudflare.com\n");
    await startPromise;

    expect(tunnel.getUrl()).toBe("https://test.trycloudflare.com");

    // Process dies unexpectedly
    mockProc.emit("close", 1);

    expect(tunnel.getUrl()).toBeNull();
    expect(tunnel.isRunning()).toBe(false);
  });
});
