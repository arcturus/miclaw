// Layer 1: MemoryManager — MEMORY.md + journals + learnings
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { resolvePath } from "./config.js";
import type { MiclawConfig } from "./config.js";
import type { ParsedLearning, LearningSource } from "./types.js";
import { DECAY_RATES } from "./types.js";

// Regex for new format: - [Type|source:X|conf:Y] content (learned DATE, reinforced DATE xN)
const NEW_FORMAT_RE =
  /^- \[(\w+)\|source:(\w+)\|conf:([\d.]+)\]\s+(.+?)\s+\(learned (\d{4}-\d{2}-\d{2})(?:,\s*reinforced (\d{4}-\d{2}-\d{2})\s+x(\d+))?\)$/;

// Regex for old format: - [Type] content (learned DATE)
const OLD_FORMAT_RE = /^- \[(\w+)\]\s+(.+?)\s+\(learned (\d{4}-\d{2}-\d{2})\)$/;

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

    // Learnings with confidence annotations
    const parsed = this.parseLearnings();
    if (parsed.length > 0) {
      const annotated = parsed
        .filter((entry) => this.computeEffectiveConfidence(entry) >= 0.10)
        .map((entry) => {
          const eff = this.computeEffectiveConfidence(entry);
          const tag = eff >= 0.8 ? "HIGH" : eff >= 0.5 ? "MED" : "LOW";
          return `- [${entry.type}] ${entry.content} (confidence: ${tag})`;
        })
        .join("\n");

      if (annotated.length > 0) {
        sections.push(
          `### Learnings\n\n_Confidence: HIGH = very reliable, MED = probably true, LOW = treat as uncertain hint._\n\n${annotated}`,
        );
      }
    }

    if (sections.length === 0) return "";
    return `## Memory\n\n${sections.join("\n\n")}`;
  }

  /** Parse a single learning line into structured data */
  parseLearning(line: string): ParsedLearning | null {
    const trimmed = line.trim();

    // Try new format first
    const newMatch = trimmed.match(NEW_FORMAT_RE);
    if (newMatch) {
      const source = newMatch[2] as LearningSource;
      return {
        type: newMatch[1],
        source: isValidSource(source) ? source : "inferred",
        confidence: parseFloat(newMatch[3]),
        content: newMatch[4],
        learnedDate: newMatch[5],
        reinforcedDate: newMatch[6] || undefined,
        reinforceCount: newMatch[7] ? parseInt(newMatch[7], 10) : 0,
        raw: trimmed,
      };
    }

    // Try old format
    const oldMatch = trimmed.match(OLD_FORMAT_RE);
    if (oldMatch) {
      return {
        type: oldMatch[1],
        source: "inferred",
        confidence: 0.70,
        content: oldMatch[2],
        learnedDate: oldMatch[3],
        reinforcedDate: undefined,
        reinforceCount: 0,
        raw: trimmed,
      };
    }

    return null;
  }

  /** Parse all learning entries from learnings.md */
  parseLearnings(): ParsedLearning[] {
    const content = this.readLearnings();
    if (!content) return [];
    return content
      .split("\n")
      .map((line) => this.parseLearning(line))
      .filter((entry): entry is ParsedLearning => entry !== null);
  }

  /** Compute effective confidence with time-based decay */
  computeEffectiveConfidence(entry: ParsedLearning, now?: Date): number {
    const today = now ?? new Date();
    const decay = DECAY_RATES[entry.source] ?? DECAY_RATES.inferred;

    // No decay for this source type
    if (decay.rate === 0) return Math.max(decay.floor, entry.confidence);

    const referenceDate = entry.reinforcedDate ?? entry.learnedDate;
    const refMs = new Date(referenceDate).getTime();
    const nowMs = today.getTime();
    const daysSince = Math.max(0, (nowMs - refMs) / (1000 * 60 * 60 * 24));

    return Math.max(decay.floor, entry.confidence - daysSince * decay.rate);
  }

  /** Reinforce an existing learning entry (bump count, reset decay clock) */
  reinforceLearning(contentSubstring: string, date: string): boolean {
    const content = this.readLearnings();
    if (!content) return false;

    const lines = content.split("\n");
    const normalized = contentSubstring.toLowerCase().trim();
    let found = false;

    for (let i = 0; i < lines.length; i++) {
      const parsed = this.parseLearning(lines[i]);
      if (!parsed) continue;

      if (parsed.content.toLowerCase().includes(normalized.slice(0, 50))) {
        const newCount = parsed.reinforceCount + 1;
        const newConf = Math.min(0.99, parsed.confidence + 0.05);
        lines[i] =
          `- [${parsed.type}|source:${parsed.source}|conf:${newConf.toFixed(2)}] ${parsed.content} (learned ${parsed.learnedDate}, reinforced ${date} x${newCount})`;
        found = true;
        break;
      }
    }

    if (found) {
      const filePath = path.join(this.memoryDir, "learnings.md");
      writeFileSync(filePath, lines.join("\n"), "utf-8");
    }

    return found;
  }

  /** Archive and prune low-confidence learnings */
  pruneLearnings(threshold: number = 0.10): { pruned: number; archived: string[] } {
    const parsed = this.parseLearnings();
    if (parsed.length === 0) return { pruned: 0, archived: [] };

    const today = new Date();
    const dateStr = today.toISOString().split("T")[0];
    const keep: string[] = [];
    const archived: string[] = [];

    for (const entry of parsed) {
      // Instructed entries are NEVER pruned
      if (entry.source === "instructed") {
        keep.push(entry.raw);
        continue;
      }

      const eff = this.computeEffectiveConfidence(entry, today);
      if (eff < threshold) {
        archived.push(`${entry.raw} (archived ${dateStr})`);
      } else {
        keep.push(entry.raw);
      }
    }

    if (archived.length > 0) {
      // Append to archive file
      const archivePath = path.join(this.memoryDir, "learnings-archived.md");
      const archiveContent = archived.map((a) => `${a}\n`).join("");
      appendFileSync(archivePath, archiveContent, "utf-8");

      // Rewrite learnings.md without pruned entries
      const filePath = path.join(this.memoryDir, "learnings.md");
      writeFileSync(filePath, keep.length > 0 ? keep.map((l) => `${l}\n`).join("") : "", "utf-8");
    }

    return { pruned: archived.length, archived };
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
    const line = `- **[${timestamp}] ${entry.role}**: ${entry.content}\n`;
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

function isValidSource(s: string): s is LearningSource {
  return ["observed", "inferred", "instructed", "hearsay"].includes(s);
}
