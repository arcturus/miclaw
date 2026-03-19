import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { SoulLoader } from "../src/soul.js";

// Mock resolvePath to use our temp dir directly
vi.mock("../src/config.js", () => ({
  resolvePath: (p: string) => p,
}));

describe("SoulLoader", () => {
  let tempDir: string;
  let loader: SoulLoader;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mikeclaw-soul-"));
    loader = new SoulLoader();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("assembles all soul files when present", () => {
    writeFileSync(path.join(tempDir, "AGENTS.md"), "You are an agent");
    writeFileSync(path.join(tempDir, "SOUL.md"), "Be concise");
    writeFileSync(path.join(tempDir, "IDENTITY.md"), "Named mikeclaw");
    writeFileSync(path.join(tempDir, "TOOLS.md"), "Use tools wisely");

    const result = loader.assemble(tempDir);
    expect(result).toContain("## Agent Role");
    expect(result).toContain("You are an agent");
    expect(result).toContain("## Personality");
    expect(result).toContain("Be concise");
    expect(result).toContain("## Identity");
    expect(result).toContain("## Tool Guidance");
  });

  it("assembles with only required files", () => {
    writeFileSync(path.join(tempDir, "AGENTS.md"), "Agent role");
    writeFileSync(path.join(tempDir, "SOUL.md"), "Soul content");

    const result = loader.assemble(tempDir);
    expect(result).toContain("Agent role");
    expect(result).toContain("Soul content");
    expect(result).not.toContain("## Identity");
  });

  it("returns fallback when no files exist", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "mikeclaw-empty-"));
    const result = loader.assemble(emptyDir);
    expect(result).toContain("helpful AI assistant");
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("skips empty files", () => {
    writeFileSync(path.join(tempDir, "AGENTS.md"), "Agent role");
    writeFileSync(path.join(tempDir, "SOUL.md"), "");

    const result = loader.assemble(tempDir);
    expect(result).toContain("Agent role");
    expect(result).not.toContain("## Personality");
  });

  it("readAll returns all files with content or null", () => {
    writeFileSync(path.join(tempDir, "AGENTS.md"), "Agent content");
    writeFileSync(path.join(tempDir, "SOUL.md"), "Soul content");

    const files = loader.readAll(tempDir);
    expect(files).toHaveLength(4);
    expect(files[0]).toEqual({ name: "AGENTS.md", content: "Agent content" });
    expect(files[1]).toEqual({ name: "SOUL.md", content: "Soul content" });
    expect(files[2]).toEqual({ name: "IDENTITY.md", content: null });
    expect(files[3]).toEqual({ name: "TOOLS.md", content: null });
  });
});
