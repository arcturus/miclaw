import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { MikeClawConfig } from "../../src/config.js";
import { WebChannel } from "../../src/channels/web.js";

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

describe("WebChannel SSE broadcasting", () => {
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

  /** Connect to SSE endpoint and collect events until done() is called */
  function connectSSE(): { events: any[]; close: () => void; waitForEvent: () => Promise<any> } {
    const events: any[] = [];
    let resolveNext: ((event: any) => void) | null = null;

    const req = http.get(`http://127.0.0.1:${port}/api/events`, (res) => {
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";
        for (const block of lines) {
          if (block.startsWith("data: ")) {
            try {
              const parsed = JSON.parse(block.slice(6));
              events.push(parsed);
              if (resolveNext) {
                const r = resolveNext;
                resolveNext = null;
                r(parsed);
              }
            } catch { /* skip keepalives/comments */ }
          }
        }
      });
    });

    return {
      events,
      close: () => req.destroy(),
      waitForEvent: () => new Promise((resolve) => {
        // Check if we already have an unprocessed event
        if (events.length > 0) {
          resolve(events[events.length - 1]);
          return;
        }
        resolveNext = resolve;
      }),
    };
  }

  it("GET /api/events returns SSE stream with connected event", async () => {
    const sse = connectSSE();
    const event = await sse.waitForEvent();
    expect(event.type).toBe("connected");
    expect(event.userId).toMatch(/^web-/);
    sse.close();
  });

  it("send() delivers message to connected SSE client", async () => {
    const sse = connectSSE();
    // Wait for connected event first
    await sse.waitForEvent();

    const userId = sse.events[0].userId;
    const sent = await channel.send(userId, "Hello from cron!");

    expect(sent).toBe(true);

    // Wait for broadcast event
    const broadcast = await new Promise<any>((resolve) => {
      const check = () => {
        const bc = sse.events.find((e) => e.type === "broadcast");
        if (bc) return resolve(bc);
        setTimeout(check, 10);
      };
      check();
    });

    expect(broadcast.type).toBe("broadcast");
    expect(broadcast.message).toBe("Hello from cron!");
    expect(broadcast.timestamp).toBeTruthy();
    sse.close();
  });

  it("send() with wildcard '*' broadcasts to all clients", async () => {
    const sse1 = connectSSE();
    const sse2 = connectSSE();
    await sse1.waitForEvent();
    await sse2.waitForEvent();

    const sent = await channel.send("*", "Broadcast to all");
    expect(sent).toBe(true);

    // Both clients should receive the message
    await new Promise((r) => setTimeout(r, 50));
    expect(sse1.events.some((e) => e.type === "broadcast" && e.message === "Broadcast to all")).toBe(true);
    expect(sse2.events.some((e) => e.type === "broadcast" && e.message === "Broadcast to all")).toBe(true);
    sse1.close();
    sse2.close();
  });

  it("send() returns false when no clients connected for userId", async () => {
    const sent = await channel.send("nonexistent-user", "Nobody here");
    expect(sent).toBe(false);
  });

  it("stop() closes all SSE connections", async () => {
    // Create a fresh channel for this test
    const p = await getPort();
    const cfg = {
      channels: {
        web: { enabled: true, port: p, host: "127.0.0.1", auth: { type: "none" as const } },
      },
    } as MikeClawConfig;
    const ch = new WebChannel(cfg);
    ch.onMessage(async () => ({ result: "ok", sessionId: "s", durationMs: 1 }));
    await ch.start();

    // Connect SSE and wait for the connected event before stopping
    const closed = new Promise<void>((resolve) => {
      http.get(`http://127.0.0.1:${p}/api/events`, (res) => {
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk.toString();
          // Once we get the connected event, trigger stop
          if (buf.includes('"connected"')) {
            ch.stop();
          }
        });
        res.on("close", () => resolve());
      });
    });

    await closed;
  });
});

describe("WebChannel SSE with API key auth", () => {
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
          auth: { type: "api-key" as const, apiKey: "sse-secret" },
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

  it("rejects SSE without token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/events`);
    expect(res.status).toBe(401);
  });

  it("accepts SSE with token query param", async () => {
    const connected = await new Promise<any>((resolve) => {
      http.get(`http://127.0.0.1:${port}/api/events?token=sse-secret`, (res) => {
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk.toString();
          if (buf.includes("\n\n")) {
            const data = buf.split("\n\n")[0];
            if (data.startsWith("data: ")) {
              resolve({ status: res.statusCode, event: JSON.parse(data.slice(6)) });
              res.destroy();
            }
          }
        });
      });
    });
    expect(connected.status).toBe(200);
    expect(connected.event.type).toBe("connected");
  });

  it("rejects SSE with wrong token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=wrong`);
    expect(res.status).toBe(401);
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
