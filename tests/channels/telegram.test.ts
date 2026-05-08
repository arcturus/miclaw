import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MiclawConfig } from "../../src/config.js";

// Capture event handlers registered by the bot
type EventCallback = (...args: any[]) => void;

function createMockBot() {
  const listeners = new Map<string, EventCallback[]>();
  return {
    on: vi.fn((event: string, cb: EventCallback) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
    }),
    sendMessage: vi.fn().mockResolvedValue({}),
    sendChatAction: vi.fn().mockResolvedValue({}),
    stopPolling: vi.fn().mockResolvedValue(undefined),
    // Helper to simulate incoming messages
    _emit(event: string, ...args: any[]) {
      for (const cb of listeners.get(event) ?? []) {
        cb(...args);
      }
    },
    _listeners: listeners,
  };
}

let mockBot: ReturnType<typeof createMockBot>;

vi.mock("node-telegram-bot-api", () => {
  return {
    default: vi.fn().mockImplementation(function (this: any) {
      mockBot = createMockBot();
      Object.assign(this, mockBot);
      return this;
    }),
  };
});

import { TelegramChannel } from "../../src/channels/telegram.js";

function makeConfig(overrides: Partial<MiclawConfig["channels"]["telegram"]> = {}): MiclawConfig {
  return {
    channels: {
      telegram: {
        enabled: true,
        token: "test-token-123",
        ...overrides,
      },
    },
    learning: { enabled: false },
  } as MiclawConfig;
}

function telegramMsg(chatId: number, text?: string) {
  return {
    chat: { id: chatId },
    text,
    message_id: 1,
    date: Date.now(),
  };
}

describe("TelegramChannel lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("start() creates bot and registers listeners", async () => {
    const channel = new TelegramChannel(makeConfig());
    channel.onMessage(async () => ({ result: "ok", sessionId: "s", durationMs: 1 }));
    await channel.start();
    expect(mockBot.on).toHaveBeenCalledWith("message", expect.any(Function));
    expect(mockBot.on).toHaveBeenCalledWith("polling_error", expect.any(Function));
    await channel.stop();
  });

  it("start() throws if no token configured", async () => {
    const channel = new TelegramChannel(makeConfig({ token: undefined }));
    await expect(channel.start()).rejects.toThrow("Bot token is required");
  });

  it("start() is idempotent", async () => {
    const TelegramBotMock = (await import("node-telegram-bot-api")).default;
    const channel = new TelegramChannel(makeConfig());
    await channel.start();
    await channel.start();
    // Constructor called only once
    expect(TelegramBotMock).toHaveBeenCalledTimes(1);
    await channel.stop();
  });

  it("stop() calls stopPolling", async () => {
    const channel = new TelegramChannel(makeConfig());
    await channel.start();
    await channel.stop();
    expect(mockBot.stopPolling).toHaveBeenCalled();
  });

  it("stop() is idempotent", async () => {
    const channel = new TelegramChannel(makeConfig());
    await channel.start();
    await channel.stop();
    await channel.stop(); // should not throw
    expect(mockBot.stopPolling).toHaveBeenCalledTimes(1);
  });
});

describe("TelegramChannel message routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes text messages to handler with correct channelId and userId", async () => {
    const handler = vi.fn().mockResolvedValue({ result: "hello back", sessionId: "s", durationMs: 1 });
    const channel = new TelegramChannel(makeConfig());
    channel.onMessage(handler);
    await channel.start();

    await mockBot._emit("message", telegramMsg(12345, "hello"));
    // Wait for async handler
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    expect(handler).toHaveBeenCalledWith({
      channelId: "telegram",
      userId: "12345",
      message: "hello",
    });
    expect(mockBot.sendMessage).toHaveBeenCalledWith("12345", "hello back");
    await channel.stop();
  });

  it("ignores non-text messages", async () => {
    const handler = vi.fn().mockResolvedValue({ result: "ok", sessionId: "s", durationMs: 1 });
    const channel = new TelegramChannel(makeConfig());
    channel.onMessage(handler);
    await channel.start();

    await mockBot._emit("message", telegramMsg(12345, undefined));
    // Give it a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
    await channel.stop();
  });

  it("sends typing indicator before processing", async () => {
    const handler = vi.fn().mockResolvedValue({ result: "ok", sessionId: "s", durationMs: 1 });
    const channel = new TelegramChannel(makeConfig());
    channel.onMessage(handler);
    await channel.start();

    await mockBot._emit("message", telegramMsg(12345, "hi"));
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    expect(mockBot.sendChatAction).toHaveBeenCalledWith("12345", "typing");
    await channel.stop();
  });

  it("sends error message when handler throws", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const channel = new TelegramChannel(makeConfig());
    channel.onMessage(handler);
    await channel.start();

    await mockBot._emit("message", telegramMsg(12345, "hi"));
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    // Wait for the catch block
    await new Promise((r) => setTimeout(r, 10));

    expect(mockBot.sendMessage).toHaveBeenCalledWith("12345", "An error occurred processing your message.");
    await channel.stop();
  });
});

describe("TelegramChannel allowedChatIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects messages from unauthorized chat IDs", async () => {
    const handler = vi.fn().mockResolvedValue({ result: "ok", sessionId: "s", durationMs: 1 });
    const channel = new TelegramChannel(makeConfig({ allowedChatIds: ["99999"] }));
    channel.onMessage(handler);
    await channel.start();

    await mockBot._emit("message", telegramMsg(12345, "hi"));
    await new Promise((r) => setTimeout(r, 10));

    expect(handler).not.toHaveBeenCalled();
    expect(mockBot.sendMessage).toHaveBeenCalledWith("12345", "Unauthorized. Your chat ID is not in the allowlist.");
    await channel.stop();
  });

  it("allows messages from authorized chat IDs", async () => {
    const handler = vi.fn().mockResolvedValue({ result: "ok", sessionId: "s", durationMs: 1 });
    const channel = new TelegramChannel(makeConfig({ allowedChatIds: ["12345"] }));
    channel.onMessage(handler);
    await channel.start();

    await mockBot._emit("message", telegramMsg(12345, "hi"));
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    await channel.stop();
  });

  it("allows all chat IDs when allowedChatIds is not set", async () => {
    const handler = vi.fn().mockResolvedValue({ result: "ok", sessionId: "s", durationMs: 1 });
    const channel = new TelegramChannel(makeConfig());
    channel.onMessage(handler);
    await channel.start();

    await mockBot._emit("message", telegramMsg(12345, "hi"));
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    await channel.stop();
  });
});

describe("TelegramChannel send/broadcast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("send() sends to specific chat ID", async () => {
    const channel = new TelegramChannel(makeConfig());
    channel.onMessage(async () => ({ result: "ok", sessionId: "s", durationMs: 1 }));
    await channel.start();

    const sent = await channel.send("12345", "Hello!");
    expect(sent).toBe(true);
    expect(mockBot.sendMessage).toHaveBeenCalledWith("12345", "Hello!");
    await channel.stop();
  });

  it("send('*') broadcasts to all known chat IDs", async () => {
    const handler = vi.fn().mockResolvedValue({ result: "ok", sessionId: "s", durationMs: 1 });
    const channel = new TelegramChannel(makeConfig());
    channel.onMessage(handler);
    await channel.start();

    // Simulate messages from two different chats to populate knownChatIds
    await mockBot._emit("message", telegramMsg(111, "a"));
    await mockBot._emit("message", telegramMsg(222, "b"));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));

    mockBot.sendMessage.mockClear();
    const sent = await channel.send("*", "Broadcast!");
    expect(sent).toBe(true);
    expect(mockBot.sendMessage).toHaveBeenCalledWith("111", "Broadcast!");
    expect(mockBot.sendMessage).toHaveBeenCalledWith("222", "Broadcast!");
    await channel.stop();
  });

  it("send() returns false when bot is not running", async () => {
    const channel = new TelegramChannel(makeConfig());
    const sent = await channel.send("12345", "Hello!");
    expect(sent).toBe(false);
  });

  it("send('*') returns false when no known chat IDs", async () => {
    const channel = new TelegramChannel(makeConfig());
    channel.onMessage(async () => ({ result: "ok", sessionId: "s", durationMs: 1 }));
    await channel.start();

    const sent = await channel.send("*", "Nobody listening");
    expect(sent).toBe(false);
    await channel.stop();
  });

  it("send('*') broadcasts to allowedChatIds seeded at start without inbound messages", async () => {
    const channel = new TelegramChannel(makeConfig({ allowedChatIds: ["100", "200"] }));
    channel.onMessage(async () => ({ result: "ok", sessionId: "s", durationMs: 1 }));
    await channel.start();

    const sent = await channel.send("*", "Proactive!");
    expect(sent).toBe(true);
    expect(mockBot.sendMessage).toHaveBeenCalledWith("100", "Proactive!");
    expect(mockBot.sendMessage).toHaveBeenCalledWith("200", "Proactive!");
    expect(mockBot.sendMessage).toHaveBeenCalledTimes(2);
    await channel.stop();
  });
});

describe("TelegramChannel long messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends messages under 4096 chars as single message", async () => {
    const handler = vi.fn().mockResolvedValue({ result: "short", sessionId: "s", durationMs: 1 });
    const channel = new TelegramChannel(makeConfig());
    channel.onMessage(handler);
    await channel.start();

    await mockBot._emit("message", telegramMsg(12345, "hi"));
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    expect(mockBot.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockBot.sendMessage).toHaveBeenCalledWith("12345", "short");
    await channel.stop();
  });

  it("splits messages over 4096 chars into multiple sends", async () => {
    const longText = "a".repeat(5000);
    const handler = vi.fn().mockResolvedValue({ result: longText, sessionId: "s", durationMs: 1 });
    const channel = new TelegramChannel(makeConfig());
    channel.onMessage(handler);
    await channel.start();

    await mockBot._emit("message", telegramMsg(12345, "hi"));
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    // Wait for all sends
    await new Promise((r) => setTimeout(r, 10));

    // Should be split into 2 chunks: 4096 + 904
    const sendCalls = mockBot.sendMessage.mock.calls;
    const responseCalls = sendCalls.filter((call: any[]) => call[0] === "12345");
    expect(responseCalls.length).toBe(2);
    expect(responseCalls[0][1].length).toBe(4096);
    expect(responseCalls[1][1].length).toBe(904);
    await channel.stop();
  });
});
