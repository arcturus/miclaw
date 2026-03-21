import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { MemoryManager } from "../src/memory.js";
import type { MiclawConfig } from "../src/config.js";

vi.mock("../src/config.js", () => ({
  resolvePath: (p: string) => p,
}));

function makeConfig(memoryDir: string): MiclawConfig {
  return { memoryDir, journalDays: 3 } as MiclawConfig;
}

describe("MemoryManager", () => {
  let tempDir: string;
  let mm: MemoryManager;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "miclaw-memory-"));
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

  // ─── Epistemic Metadata Tests ─────────────────────────────

  describe("parseLearning", () => {
    it("parses new format with full metadata", () => {
      const line = "- [Pattern|source:inferred|conf:0.65] User prefers concise answers (learned 2026-03-15)";
      const parsed = mm.parseLearning(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe("Pattern");
      expect(parsed!.source).toBe("inferred");
      expect(parsed!.confidence).toBe(0.65);
      expect(parsed!.content).toBe("User prefers concise answers");
      expect(parsed!.learnedDate).toBe("2026-03-15");
      expect(parsed!.reinforceCount).toBe(0);
      expect(parsed!.reinforcedDate).toBeUndefined();
    });

    it("parses new format with reinforcement data", () => {
      const line =
        "- [Preference|source:instructed|conf:0.95] Always use dark mode (learned 2026-03-10, reinforced 2026-03-20 x3)";
      const parsed = mm.parseLearning(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe("Preference");
      expect(parsed!.source).toBe("instructed");
      expect(parsed!.confidence).toBe(0.95);
      expect(parsed!.content).toBe("Always use dark mode");
      expect(parsed!.learnedDate).toBe("2026-03-10");
      expect(parsed!.reinforcedDate).toBe("2026-03-20");
      expect(parsed!.reinforceCount).toBe(3);
    });

    it("parses old format with backward compat defaults", () => {
      const line = "- [Pattern] User likes TypeScript (learned 2026-03-01)";
      const parsed = mm.parseLearning(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe("Pattern");
      expect(parsed!.source).toBe("inferred");
      expect(parsed!.confidence).toBe(0.7);
      expect(parsed!.content).toBe("User likes TypeScript");
      expect(parsed!.learnedDate).toBe("2026-03-01");
      expect(parsed!.reinforceCount).toBe(0);
    });

    it("returns null for non-learning lines", () => {
      expect(mm.parseLearning("## Header")).toBeNull();
      expect(mm.parseLearning("Not a learning")).toBeNull();
      expect(mm.parseLearning("")).toBeNull();
    });

    it("defaults invalid source to inferred", () => {
      const line = "- [Pattern|source:bogus|conf:0.50] something (learned 2026-03-15)";
      const parsed = mm.parseLearning(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.source).toBe("inferred");
    });
  });

  describe("parseLearnings", () => {
    it("parses mixed old and new format entries", () => {
      const content = [
        "- [Pattern] Old format entry (learned 2026-03-01)",
        "- [Preference|source:instructed|conf:0.95] New format entry (learned 2026-03-15)",
        "## Header (ignored)",
        "- [Mistake|source:observed|conf:0.90] An observed mistake (learned 2026-03-20)",
      ].join("\n");
      writeFileSync(path.join(tempDir, "learnings.md"), content);
      mm = new MemoryManager(makeConfig(tempDir));

      const parsed = mm.parseLearnings();
      expect(parsed).toHaveLength(3);
      expect(parsed[0].source).toBe("inferred"); // old format default
      expect(parsed[1].source).toBe("instructed");
      expect(parsed[2].source).toBe("observed");
    });

    it("returns empty array when no learnings file", () => {
      expect(mm.parseLearnings()).toEqual([]);
    });
  });

  describe("computeEffectiveConfidence", () => {
    it("instructed entries never decay", () => {
      const entry = makeParsedLearning({ source: "instructed", confidence: 0.95, learnedDate: "2026-01-01" });
      // 80 days later
      const eff = mm.computeEffectiveConfidence(entry, new Date("2026-03-22"));
      expect(eff).toBe(0.95);
    });

    it("observed entries never decay", () => {
      const entry = makeParsedLearning({ source: "observed", confidence: 0.90, learnedDate: "2026-01-01" });
      const eff = mm.computeEffectiveConfidence(entry, new Date("2026-03-22"));
      expect(eff).toBe(0.90);
    });

    it("inferred entries decay at 0.02/day", () => {
      const entry = makeParsedLearning({ source: "inferred", confidence: 0.65, learnedDate: "2026-03-01" });
      // 21 days later: 0.65 - (21 * 0.02) = 0.65 - 0.42 = 0.23
      const eff = mm.computeEffectiveConfidence(entry, new Date("2026-03-22"));
      expect(eff).toBeCloseTo(0.23, 1);
    });

    it("inferred entries have floor of 0.10", () => {
      const entry = makeParsedLearning({ source: "inferred", confidence: 0.65, learnedDate: "2026-01-01" });
      // 80 days: 0.65 - (80 * 0.02) = 0.65 - 1.60 → clamped to 0.10
      const eff = mm.computeEffectiveConfidence(entry, new Date("2026-03-22"));
      expect(eff).toBe(0.10);
    });

    it("hearsay entries decay at 0.03/day", () => {
      const entry = makeParsedLearning({ source: "hearsay", confidence: 0.40, learnedDate: "2026-03-12" });
      // 10 days later: 0.40 - (10 * 0.03) = 0.40 - 0.30 = 0.10
      const eff = mm.computeEffectiveConfidence(entry, new Date("2026-03-22"));
      expect(eff).toBeCloseTo(0.10, 1);
    });

    it("hearsay entries have floor of 0.05", () => {
      const entry = makeParsedLearning({ source: "hearsay", confidence: 0.40, learnedDate: "2026-01-01" });
      const eff = mm.computeEffectiveConfidence(entry, new Date("2026-03-22"));
      expect(eff).toBe(0.05);
    });

    it("reinforcement date resets decay clock", () => {
      const entry = makeParsedLearning({
        source: "inferred",
        confidence: 0.70,
        learnedDate: "2026-01-01",
        reinforcedDate: "2026-03-20",
      });
      // Only 2 days since reinforcement: 0.70 - (2 * 0.02) = 0.66
      const eff = mm.computeEffectiveConfidence(entry, new Date("2026-03-22"));
      expect(eff).toBeCloseTo(0.66, 1);
    });
  });

  describe("getContext with confidence annotations", () => {
    it("annotates learnings with HIGH/MED/LOW tags", () => {
      const content = [
        "- [Preference|source:instructed|conf:0.95] Use dark mode (learned 2026-03-21)",
        "- [Pattern|source:inferred|conf:0.65] Prefers short answers (learned 2026-03-20)",
      ].join("\n");
      writeFileSync(path.join(tempDir, "learnings.md"), content);
      mm = new MemoryManager(makeConfig(tempDir));

      const ctx = mm.getContext();
      expect(ctx).toContain("(confidence: HIGH)");
      expect(ctx).toContain("(confidence: MED)");
      expect(ctx).toContain("Confidence: HIGH = very reliable");
    });

    it("filters out entries below 0.10 effective confidence", () => {
      // Old entry that should have decayed below threshold
      const content = "- [Pattern|source:hearsay|conf:0.40] Stale hearsay (learned 2025-01-01)";
      writeFileSync(path.join(tempDir, "learnings.md"), content);
      mm = new MemoryManager(makeConfig(tempDir));

      const ctx = mm.getContext();
      expect(ctx).not.toContain("Stale hearsay");
    });
  });

  describe("reinforceLearning", () => {
    it("bumps reinforcement count and confidence", () => {
      const content = "- [Pattern|source:inferred|conf:0.65] User prefers concise answers (learned 2026-03-15)\n";
      writeFileSync(path.join(tempDir, "learnings.md"), content);
      mm = new MemoryManager(makeConfig(tempDir));

      const result = mm.reinforceLearning("concise answers", "2026-03-21");
      expect(result).toBe(true);

      const updated = readFileSync(path.join(tempDir, "learnings.md"), "utf-8");
      expect(updated).toContain("conf:0.70");
      expect(updated).toContain("reinforced 2026-03-21 x1");
    });

    it("returns false when no matching entry found", () => {
      const content = "- [Pattern|source:inferred|conf:0.65] Something else (learned 2026-03-15)\n";
      writeFileSync(path.join(tempDir, "learnings.md"), content);
      mm = new MemoryManager(makeConfig(tempDir));

      const result = mm.reinforceLearning("nonexistent content", "2026-03-21");
      expect(result).toBe(false);
    });

    it("returns false when no learnings file", () => {
      expect(mm.reinforceLearning("anything", "2026-03-21")).toBe(false);
    });
  });

  describe("pruneLearnings", () => {
    it("archives decayed entries and keeps fresh ones", () => {
      const content = [
        "- [Pattern|source:hearsay|conf:0.40] Stale hearsay (learned 2025-01-01)",
        "- [Preference|source:instructed|conf:0.95] User instruction (learned 2025-01-01)",
        "- [Pattern|source:inferred|conf:0.65] Recent inference (learned 2026-03-20)",
      ]
        .map((l) => l + "\n")
        .join("");
      writeFileSync(path.join(tempDir, "learnings.md"), content);
      mm = new MemoryManager(makeConfig(tempDir));

      const result = mm.pruneLearnings();
      expect(result.pruned).toBe(1); // only the stale hearsay

      // Verify learnings.md no longer has stale entry
      const remaining = readFileSync(path.join(tempDir, "learnings.md"), "utf-8");
      expect(remaining).not.toContain("Stale hearsay");
      expect(remaining).toContain("User instruction"); // instructed preserved
      expect(remaining).toContain("Recent inference"); // fresh enough

      // Verify archive file has the pruned entry
      const archivePath = path.join(tempDir, "learnings-archived.md");
      expect(existsSync(archivePath)).toBe(true);
      const archived = readFileSync(archivePath, "utf-8");
      expect(archived).toContain("Stale hearsay");
      expect(archived).toContain("(archived");
    });

    it("never prunes instructed entries regardless of age", () => {
      const content = "- [Preference|source:instructed|conf:0.95] Ancient instruction (learned 2020-01-01)\n";
      writeFileSync(path.join(tempDir, "learnings.md"), content);
      mm = new MemoryManager(makeConfig(tempDir));

      const result = mm.pruneLearnings();
      expect(result.pruned).toBe(0);

      const remaining = readFileSync(path.join(tempDir, "learnings.md"), "utf-8");
      expect(remaining).toContain("Ancient instruction");
    });

    it("returns zero when no learnings exist", () => {
      const result = mm.pruneLearnings();
      expect(result.pruned).toBe(0);
      expect(result.archived).toEqual([]);
    });

    it("handles all entries being pruned", () => {
      const content = "- [Pattern|source:hearsay|conf:0.40] Very old hearsay (learned 2020-01-01)\n";
      writeFileSync(path.join(tempDir, "learnings.md"), content);
      mm = new MemoryManager(makeConfig(tempDir));

      const result = mm.pruneLearnings();
      expect(result.pruned).toBe(1);

      const remaining = readFileSync(path.join(tempDir, "learnings.md"), "utf-8");
      expect(remaining.trim()).toBe("");
    });
  });
});

// Helper to create ParsedLearning objects for testing
function makeParsedLearning(overrides: Partial<import("../src/types.js").ParsedLearning> = {}): import("../src/types.js").ParsedLearning {
  return {
    type: "Pattern",
    source: "inferred",
    confidence: 0.65,
    content: "test content",
    learnedDate: "2026-03-15",
    reinforceCount: 0,
    raw: "- [Pattern|source:inferred|conf:0.65] test content (learned 2026-03-15)",
    ...overrides,
  };
}
