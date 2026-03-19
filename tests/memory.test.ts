import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { MemoryManager } from "../src/memory.js";
import type { MikeClawConfig } from "../src/config.js";

vi.mock("../src/config.js", () => ({
  resolvePath: (p: string) => p,
}));

function makeConfig(memoryDir: string): MikeClawConfig {
  return { memoryDir, journalDays: 3 } as MikeClawConfig;
}

describe("MemoryManager", () => {
  let tempDir: string;
  let mm: MemoryManager;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mikeclaw-memory-"));
    mm = new MemoryManager(makeConfig(tempDir));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("getContext returns empty string when no memory files exist", () => {
    expect(mm.getContext()).toBe("");
  });

  it("getContext includes long-term memory", () => {
    writeFileSync(path.join(tempDir, "MEMORY.md"), "User prefers TypeScript");
    mm = new MemoryManager(makeConfig(tempDir));
    const ctx = mm.getContext();
    expect(ctx).toContain("Long-Term Memory");
    expect(ctx).toContain("User prefers TypeScript");
  });

  it("appendJournal writes timestamped entry", () => {
    mm.appendJournal({ role: "user", content: "Hello world" });
    const today = new Date().toISOString().split("T")[0];
    const journalPath = path.join(tempDir, "journals", `${today}.md`);
    expect(existsSync(journalPath)).toBe(true);
    const content = readFileSync(journalPath, "utf-8");
    expect(content).toContain("user");
    expect(content).toContain("Hello world");
  });

  it("appendJournal truncates long content", () => {
    const longContent = "x".repeat(1000);
    mm.appendJournal({ role: "user", content: longContent });
    const today = new Date().toISOString().split("T")[0];
    const content = readFileSync(path.join(tempDir, "journals", `${today}.md`), "utf-8");
    expect(content.length).toBeLessThan(600);
  });

  it("readLearnings returns empty string when no file", () => {
    expect(mm.readLearnings()).toBe("");
  });

  it("appendLearnings and countLearnings work correctly", () => {
    mm.appendLearnings(["First learning", "Second learning"]);
    expect(mm.countLearnings()).toBe(2);
    expect(mm.readLearnings()).toContain("First learning");
    expect(mm.readLearnings()).toContain("Second learning");
  });

  it("countLearnings counts lines starting with '- '", () => {
    writeFileSync(path.join(tempDir, "learnings.md"), "## Header\n- Item 1\n- Item 2\nNot an item\n- Item 3\n");
    mm = new MemoryManager(makeConfig(tempDir));
    expect(mm.countLearnings()).toBe(3);
  });

  it("listJournalDates returns sorted dates descending", () => {
    const journalsDir = path.join(tempDir, "journals");
    writeFileSync(path.join(journalsDir, "2026-03-15.md"), "entry1");
    writeFileSync(path.join(journalsDir, "2026-03-17.md"), "entry2");
    writeFileSync(path.join(journalsDir, "2026-03-16.md"), "entry3");
    const dates = mm.listJournalDates();
    expect(dates).toEqual(["2026-03-17", "2026-03-16", "2026-03-15"]);
  });

  it("readJournal returns content for valid date", () => {
    const journalsDir = path.join(tempDir, "journals");
    writeFileSync(path.join(journalsDir, "2026-03-17.md"), "test entry");
    expect(mm.readJournal("2026-03-17")).toBe("test entry");
  });

  it("readJournal returns null for missing date", () => {
    expect(mm.readJournal("2099-01-01")).toBeNull();
  });

  it("readJournal rejects path traversal", () => {
    expect(mm.readJournal("../../../etc/passwd")).toBeNull();
    expect(mm.readJournal("2026-03-17/../../secret")).toBeNull();
  });

  it("readMemory returns content of MEMORY.md", () => {
    writeFileSync(path.join(tempDir, "MEMORY.md"), "long term stuff");
    mm = new MemoryManager(makeConfig(tempDir));
    expect(mm.readMemory()).toBe("long term stuff");
  });
});
