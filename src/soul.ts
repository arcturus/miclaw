// Layer 1: SoulLoader — reads and concatenates soul markdown files
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { resolvePath } from "./config.js";

export interface SoulFile {
  name: string;
  required: boolean;
  header: string;
}

/** Ordered list of soul files to read. First = highest priority. */
const SOUL_FILES: SoulFile[] = [
  { name: "AGENTS.md", required: true, header: "## Agent Role" },
  { name: "SOUL.md", required: true, header: "## Personality" },
  { name: "IDENTITY.md", required: false, header: "## Identity" },
  { name: "TOOLS.md", required: false, header: "## Tool Guidance" },
];

export class SoulLoader {
  /**
   * Assemble the soul prompt from markdown files in the given directory.
   * @param soulDir Path to the soul directory (config-relative or absolute)
   * @returns Concatenated soul prompt string
   */
  assemble(soulDir: string): string {
    const dir = resolvePath(soulDir);
    const sections: string[] = [];

    for (const file of SOUL_FILES) {
      const filePath = path.join(dir, file.name);
      if (!existsSync(filePath)) {
        if (file.required) {
          console.warn(`[soul] Warning: required soul file missing: ${filePath}`);
        }
        continue;
      }

      try {
        const content = readFileSync(filePath, "utf-8").trim();
        if (content.length > 0) {
          sections.push(`${file.header}\n\n${content}`);
        }
      } catch (err) {
        console.warn(`[soul] Error reading ${filePath}: ${err}`);
      }
    }

    if (sections.length === 0) {
      return "You are a helpful AI assistant named miclaw.";
    }

    return sections.join("\n\n---\n\n");
  }

  /** Read all soul files and return their raw content (for admin) */
  readAll(soulDir: string): Array<{ name: string; content: string | null }> {
    const dir = resolvePath(soulDir);
    return SOUL_FILES.map((file) => {
      const filePath = path.join(dir, file.name);
      if (!existsSync(filePath)) return { name: file.name, content: null };
      try {
        return { name: file.name, content: readFileSync(filePath, "utf-8").trim() };
      } catch {
        return { name: file.name, content: null };
      }
    });
  }
}
