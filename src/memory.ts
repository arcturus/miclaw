// Layer 1: MemoryManager — MEMORY.md + journals + learnings
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { resolvePath } from "./config.js";
import type { MiclawConfig } from "./config.js";

export class MemoryManager {
  private memoryDir: string;
  private journalsDir: string;

  constructor(private config: MiclawConfig) {
    this.memoryDir = resolvePath(config.memoryDir);
    this.journalsDir = path.join(this.memoryDir, "journals");
    mkdirSync(this.journalsDir, { recursive: true });
  }

  /** Get the full memory context for system prompt injection */
  getContext(): string {
    const sections: string[] = [];

    // Long-term memory
    const longTerm = this.readFile("MEMORY.md");
    if (longTerm) {
      sections.push(`### Long-Term Memory\n\n${longTerm}`);
    }

    // Recent journals
    const journals = this.getRecentJournals(this.config.journalDays);
    if (journals) {
      sections.push(`### Recent Context\n\n${journals}`);
    }

    // Learnings
    const learnings = this.readFile("learnings.md");
    if (learnings) {
      sections.push(`### Learnings\n\n${learnings}`);
    }

    if (sections.length === 0) return "";
    return `## Memory\n\n${sections.join("\n\n")}`;
  }

  /** Read a file from the memory directory, return null if missing */
  private readFile(name: string): string | null {
    const filePath = path.join(this.memoryDir, name);
    if (!existsSync(filePath)) return null;
    try {
      const content = readFileSync(filePath, "utf-8").trim();
      return content.length > 0 ? content : null;
    } catch {
      return null;
    }
  }

  /** Get journal entries from the last N days */
  private getRecentJournals(days: number): string | null {
    const entries: string[] = [];
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split("T")[0];
      const journalPath = path.join(this.journalsDir, `${dateStr}.md`);

      if (existsSync(journalPath)) {
        try {
          const content = readFileSync(journalPath, "utf-8").trim();
          if (content.length > 0) {
            entries.push(`#### ${dateStr}\n\n${content}`);
          }
        } catch {
          // skip corrupt journals
        }
      }
    }

    return entries.length > 0 ? entries.join("\n\n") : null;
  }

  /** Append an entry to today's journal */
  appendJournal(entry: { role: string; content: string }): void {
    const dateStr = new Date().toISOString().split("T")[0];
    const journalPath = path.join(this.journalsDir, `${dateStr}.md`);
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
    const line = `- **[${timestamp}] ${entry.role}**: ${entry.content.slice(0, 500)}\n`;
    appendFileSync(journalPath, line, "utf-8");
  }

  /** Read current learnings file content */
  readLearnings(): string {
    return this.readFile("learnings.md") ?? "";
  }

  /** Append new learning entries to learnings.md */
  appendLearnings(entries: string[]): void {
    if (entries.length === 0) return;
    const filePath = path.join(this.memoryDir, "learnings.md");
    const content = entries.map((e) => `- ${e}\n`).join("");
    appendFileSync(filePath, content, "utf-8");
  }

  /** Count learning entries (approximate: count lines starting with "- ") */
  countLearnings(): number {
    const content = this.readLearnings();
    if (!content) return 0;
    return content.split("\n").filter((line) => line.startsWith("- ")).length;
  }

  /** Read long-term memory */
  readMemory(): string {
    return this.readFile("MEMORY.md") ?? "";
  }

  /** List available journal dates */
  listJournalDates(): string[] {
    if (!existsSync(this.journalsDir)) return [];
    return readdirSync(this.journalsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(".md", ""))
      .sort()
      .reverse();
  }

  /** Read a specific journal by date (validates date format to prevent path traversal) */
  readJournal(date: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const journalPath = path.join(this.journalsDir, `${date}.md`);
    // Verify resolved path is within journals directory
    if (!path.resolve(journalPath).startsWith(path.resolve(this.journalsDir))) return null;
    if (!existsSync(journalPath)) return null;
    try {
      return readFileSync(journalPath, "utf-8").trim();
    } catch {
      return null;
    }
  }
}
