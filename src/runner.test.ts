import { describe, it, expect } from "vitest";
import { ProcessPool, parseStreamOutput } from "./runner.js";

describe("ProcessPool", () => {
  it("allows acquire up to maxConcurrent", async () => {
    const pool = new ProcessPool(2, 5);
    await pool.acquire(); // slot 1
    await pool.acquire(); // slot 2
    pool.release();
    pool.release();
  });

  it("queues when at capacity and releases on next release", async () => {
    const pool = new ProcessPool(1, 5, 5000);
    await pool.acquire();

    let resolved = false;
    const pending = pool.acquire().then(() => { resolved = true; });

    expect(resolved).toBe(false);

    pool.release();
    await pending;
    expect(resolved).toBe(true);
    pool.release();
  });

  it("throws when queue overflows", async () => {
    const pool = new ProcessPool(1, 1, 5000);
    await pool.acquire();

    const p1 = pool.acquire();

    await expect(pool.acquire()).rejects.toThrow("Service at capacity");

    pool.release();
    await p1;
    pool.release();
  });

  it("times out queued requests", async () => {
    const pool = new ProcessPool(1, 5, 50);
    await pool.acquire();

    await expect(pool.acquire()).rejects.toThrow("Queue timeout");
    pool.release();
  });
});

// Helper: build a Claude Code stream-json assistant event
function assistantEvent(content: Array<{ type: string; text?: string; name?: string; input?: any }>) {
  return JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      role: "assistant",
      content,
    },
    session_id: "test-session",
  });
}

function resultEvent(overrides: Record<string, any> = {}) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    session_id: "test-session",
    total_cost_usd: 0.01,
    num_turns: 1,
    duration_ms: 500,
    duration_api_ms: 480,
    ...overrides,
  });
}

function systemEvent() {
  return JSON.stringify({ type: "system", subtype: "init", session_id: "test-session" });
}

describe("parseStreamOutput", () => {
  it("extracts text from assistant message content blocks", () => {
    const stream = [
      systemEvent(),
      assistantEvent([{ type: "text", text: "Hello world" }]),
      resultEvent({ result: "Hello world" }),
    ].join("\n");

    const { result, accumulatedText, toolUses } = parseStreamOutput(stream, 0);
    expect(result).not.toBeNull();
    expect(result!.result).toBe("Hello world");
    expect(accumulatedText).toBe("Hello world");
    expect(result!.session_id).toBe("test-session");
    expect(result!.cost_usd).toBe(0.01);
    expect(toolUses).toEqual([]);
  });

  it("accumulates text across multiple assistant events with tool use between", () => {
    const stream = [
      systemEvent(),
      assistantEvent([
        { type: "text", text: "Part 1" },
        { type: "tool_use", name: "Read", input: { file: "/tmp/x" } },
      ]),
      // user tool_result event
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "file contents", tool_use_id: "t1" }] },
      }),
      assistantEvent([{ type: "text", text: "Part 2" }]),
      resultEvent({ result: "", num_turns: 2, total_cost_usd: 0.05 }),
    ].join("\n");

    const { result, accumulatedText, toolUses } = parseStreamOutput(stream, 0);
    expect(result).not.toBeNull();
    expect(result!.result).toBe(""); // result field is empty
    expect(accumulatedText).toBe("Part 1\nPart 2"); // accumulated text has it all
    expect(toolUses).toEqual(["Read"]);
  });

  it("uses total_cost_usd field", () => {
    const stream = resultEvent({ result: "ok", total_cost_usd: 0.123 });
    const { result } = parseStreamOutput(stream, 0);
    expect(result!.cost_usd).toBe(0.123);
  });

  it("falls back to cost_usd field", () => {
    const stream = JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      result: "ok", session_id: "s", cost_usd: 0.456,
    });
    const { result } = parseStreamOutput(stream, 0);
    expect(result!.cost_usd).toBe(0.456);
  });

  it("returns null result when no result event present", () => {
    const stream = assistantEvent([{ type: "text", text: "partial" }]);
    const { result, accumulatedText } = parseStreamOutput(stream, 0);
    expect(result).toBeNull();
    expect(accumulatedText).toBe("partial");
  });

  it("tracks multiple tool uses across events", () => {
    const stream = [
      assistantEvent([
        { type: "tool_use", name: "Read" },
        { type: "tool_use", name: "Grep" },
      ]),
      assistantEvent([{ type: "tool_use", name: "Bash" }]),
      resultEvent({ result: "done" }),
    ].join("\n");

    const { toolUses } = parseStreamOutput(stream, 0);
    expect(toolUses).toEqual(["Read", "Grep", "Bash"]);
  });

  it("handles malformed lines gracefully", () => {
    const stream = [
      assistantEvent([{ type: "text", text: "good" }]),
      "this is not json",
      '{"broken json',
      resultEvent(),
    ].join("\n");

    const { result, accumulatedText } = parseStreamOutput(stream, 0);
    expect(result).not.toBeNull();
    expect(accumulatedText).toBe("good");
  });

  it("handles empty stream", () => {
    const { result, accumulatedText, toolUses } = parseStreamOutput("", 0);
    expect(result).toBeNull();
    expect(accumulatedText).toBe("");
    expect(toolUses).toEqual([]);
  });

  it("detects error results", () => {
    const stream = resultEvent({
      subtype: "error_max_turns",
      is_error: true,
      result: "Too many turns",
    });

    const { result } = parseStreamOutput(stream, 0);
    expect(result!.is_error).toBe(true);
    expect(result!.subtype).toBe("error_max_turns");
    expect(result!.result).toBe("Too many turns");
  });

  it("extracts tool results from user events", () => {
    const stream = [
      assistantEvent([{ type: "tool_use", name: "Read" }]),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "file data here", tool_use_id: "t1", is_error: false }],
        },
      }),
      assistantEvent([{ type: "text", text: "Based on the file..." }]),
      resultEvent(),
    ].join("\n");

    const { accumulatedText, toolUses } = parseStreamOutput(stream, 0);
    expect(toolUses).toEqual(["Read"]);
    expect(accumulatedText).toBe("Based on the file...");
  });
});
