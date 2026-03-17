import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { MikeClawConfig } from "../config.js";
import { WebChannel } from "./web.js";

// Find a random available port
function getPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function fetch(url: string, opts?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<{ status: number; body: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: opts?.method ?? "GET",
      headers: { "Content-Type": "application/json", ...opts?.headers },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({
          status: res.statusCode!,
          body: data,
          json: () => JSON.parse(data),
        });
      });
    });
    req.on("error", reject);
    if (opts?.body) req.write(opts.body);
    req.end();
  });
}

describe("WebChannel", () => {
  let port: number;
  let channel: WebChannel;

  beforeAll(async () => {
    port = await getPort();
    const config = {
      channels: {
        web: {
          enabled: true,
          port,
          host: "127.0.0.1",
          auth: { type: "none" as const },
        },
      },
    } as MikeClawConfig;
    channel = new WebChannel(config);
    channel.onMessage(async (input) => ({
      result: `echo: ${input.message}`,
      sessionId: "test-session",
      durationMs: 1,
    }));
    await channel.start();
  });

  afterAll(async () => {
    await channel.stop();
  });

  it("GET /api/health returns ok", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  it("POST /api/chat returns result", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(200);
    const data = res.json();
    expect(data.result).toBe("echo: hello");
    expect(data.sessionId).toBe("test-session");
  });

  it("POST /api/chat with missing message returns 400", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ notMessage: "hello" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/chat with invalid JSON returns 400", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("GET /unknown returns 404", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/unknown`);
    expect(res.status).toBe(404);
  });

  it("sets security headers", async () => {
    const res = await new Promise<http.IncomingMessage>((resolve) => {
      http.get(`http://127.0.0.1:${port}/api/health`, resolve);
    });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
});

describe("WebChannel with API key auth", () => {
  let port: number;
  let channel: WebChannel;

  beforeAll(async () => {
    port = await getPort();
    const config = {
      channels: {
        web: {
          enabled: true,
          port,
          host: "127.0.0.1",
          auth: { type: "api-key" as const, apiKey: "test-secret-key" },
        },
      },
    } as MikeClawConfig;
    channel = new WebChannel(config);
    channel.onMessage(async () => ({ result: "ok", sessionId: "s", durationMs: 1 }));
    await channel.start();
  });

  afterAll(async () => {
    await channel.stop();
  });

  it("rejects request without auth header", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects request with wrong key", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ message: "hello" }),
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts request with correct key", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ message: "hello" }),
      headers: { Authorization: "Bearer test-secret-key" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects empty bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ message: "hello" }),
      headers: { Authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });
});
