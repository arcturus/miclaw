// Layer 1: SkillLoader — loads SKILL.md files with YAML frontmatter
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import matter from "gray-matter";
import { resolvePath } from "./config.js";
import type { SkillDefinition } from "./types.js";

export class SkillLoader {
  private skills: SkillDefinition[] = [];
  private loaded = false;

  constructor(private skillsDir: string) {}

  /** Load all skills from the skills directory */
  load(): SkillDefinition[] {
    if (this.loaded) return this.skills;

    const dir = resolvePath(this.skillsDir);
    if (!existsSync(dir)) {
      this.loaded = true;
      return this.skills;
    }

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = path.join(dir, entry.name, "SKILL.md");
        if (existsSync(skillPath)) {
          const skill = this.parseSkill(skillPath);
          if (skill) this.skills.push(skill);
        }
      } else if (entry.name === "SKILL.md" || entry.name.endsWith(".skill.md")) {
        const skillPath = path.join(dir, entry.name);
        const skill = this.parseSkill(skillPath);
        if (skill) this.skills.push(skill);
      }
    }

    this.loaded = true;
    return this.skills;
  }

  /** Parse a single SKILL.md file */
  private parseSkill(filePath: string): SkillDefinition | null {
    try {
      const raw = readFileSync(filePath, "utf-8");
      // gray-matter with engines: false to prevent code execution (CVE-2022-0505)
      const parsed = matter(raw, { engines: {} as any });

      const data = parsed.data as Record<string, any>;
      if (!data.name || !data.description) {
        console.warn(`[skills] Skipping ${filePath}: missing name or description in frontmatter`);
        return null;
      }

      const skill: SkillDefinition = {
        name: data.name,
        description: data.description,
        allowedTools: this.parseAllowedTools(data["allowed-tools"]),
        body: parsed.content.trim(),
        filePath,
      };

      if (data.requires) {
        skill.requires = {
          bins: data.requires.bins,
          env: data.requires.env,
          os: data.requires.os,
        };
      }

      // Check gates
      if (!this.checkGates(skill)) {
        console.warn(`[skills] Skipping ${skill.name}: gate check failed`);
        return null;
      }

      return skill;
    } catch (err) {
      console.warn(`[skills] Error parsing ${filePath}: ${err}`);
      return null;
    }
  }

  /** Parse allowed-tools from frontmatter (can be string or array) */
  private parseAllowedTools(value: unknown): string[] {
    if (!value) return [];
    if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
    if (Array.isArray(value)) return value.map(String);
    return [];
  }

  /** Check that skill prerequisites are met */
  private checkGates(skill: SkillDefinition): boolean {
    if (!skill.requires) return true;

    // OS check
    if (skill.requires.os && skill.requires.os.length > 0) {
      if (!skill.requires.os.includes(process.platform as any)) {
        return false;
      }
    }

    // Binary check (validate bin names to prevent command injection)
    if (skill.requires.bins) {
      const SAFE_BIN_NAME = /^[a-zA-Z0-9_.-]+$/;
      for (const bin of skill.requires.bins) {
        if (!SAFE_BIN_NAME.test(bin)) {
          console.warn(`[skills] Unsafe binary name rejected: ${bin}`);
          return false;
        }
        try {
          execSync("which " + bin, { stdio: "ignore", timeout: 5000 });
        } catch {
          return false;
        }
      }
    }

    // Env check
    if (skill.requires.env) {
      for (const envVar of skill.requires.env) {
        if (!process.env[envVar]) return false;
      }
    }

    return true;
  }

  /** Get the skills section for system prompt injection */
  getPromptSection(): string {
    const skills = this.load();
    if (skills.length === 0) return "";

    const lines = ["## Available Skills\n"];
    for (const skill of skills) {
      lines.push(`### ${skill.name}\n`);
      lines.push(`${skill.description}\n`);
      if (skill.body) {
        lines.push(skill.body);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /** Get all allowed tools from all loaded skills */
  getAllAllowedTools(): string[] {
    const skills = this.load();
    const tools = new Set<string>();
    for (const skill of skills) {
      for (const tool of skill.allowedTools) {
        tools.add(tool);
      }
    }
    return [...tools];
  }
}
