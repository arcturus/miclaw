import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { SkillLoader } from "./skills.js";

vi.mock("./config.js", () => ({
  resolvePath: (p: string) => p,
}));

describe("SkillLoader", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mikeclaw-skills-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("load returns empty array when no skills directory", () => {
    const loader = new SkillLoader("/nonexistent/path");
    expect(loader.load()).toEqual([]);
  });

  it("load parses valid SKILL.md with frontmatter", () => {
    const skillDir = path.join(tempDir, "my-skill");
    mkdirSync(skillDir);
    writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: test-skill
description: A test skill
allowed-tools:
  - Read
  - WebSearch
---

# Instructions
Do the thing.
`);
    const loader = new SkillLoader(tempDir);
    const skills = loader.load();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("test-skill");
    expect(skills[0].description).toBe("A test skill");
    expect(skills[0].allowedTools).toEqual(["Read", "WebSearch"]);
    expect(skills[0].body).toContain("Do the thing.");
  });

  it("skips skills with missing frontmatter fields", () => {
    const skillDir = path.join(tempDir, "bad-skill");
    mkdirSync(skillDir);
    writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: incomplete
---
Missing description field.
`);
    const loader = new SkillLoader(tempDir);
    expect(loader.load()).toHaveLength(0);
  });

  it("getPromptSection formats skills correctly", () => {
    const skillDir = path.join(tempDir, "skill1");
    mkdirSync(skillDir);
    writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: researcher
description: Research topics online
allowed-tools: WebSearch, WebFetch
---
Search and summarize.
`);
    const loader = new SkillLoader(tempDir);
    const section = loader.getPromptSection();
    expect(section).toContain("## Available Skills");
    expect(section).toContain("### researcher");
    expect(section).toContain("Research topics online");
  });

  it("getAllAllowedTools deduplicates across skills", () => {
    mkdirSync(path.join(tempDir, "s1"));
    mkdirSync(path.join(tempDir, "s2"));
    writeFileSync(path.join(tempDir, "s1", "SKILL.md"), `---
name: s1
description: Skill 1
allowed-tools: [Read, WebSearch]
---
Body 1
`);
    writeFileSync(path.join(tempDir, "s2", "SKILL.md"), `---
name: s2
description: Skill 2
allowed-tools: [Read, Grep]
---
Body 2
`);
    const loader = new SkillLoader(tempDir);
    const tools = loader.getAllAllowedTools();
    expect(tools).toContain("Read");
    expect(tools).toContain("WebSearch");
    expect(tools).toContain("Grep");
    // No duplicates
    expect(tools.filter((t) => t === "Read")).toHaveLength(1);
  });

  it("parseAllowedTools handles comma-separated strings", () => {
    const skillDir = path.join(tempDir, "csv-skill");
    mkdirSync(skillDir);
    writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: csv
description: CSV tools test
allowed-tools: "Read, Write, Grep"
---
Body
`);
    const loader = new SkillLoader(tempDir);
    const skills = loader.load();
    expect(skills[0].allowedTools).toEqual(["Read", "Write", "Grep"]);
  });
});
