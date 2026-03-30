import { describe, it, expect } from "vitest";
import { buildAgentDirectory, parseDelegationBlocks } from "../src/orchestrator.js";
import type { AgentConfig } from "../src/types.js";

function makeAgent(id: string, description: string): AgentConfig {
  return { id, description, soulDir: "./soul", skills: [] };
}

describe("buildAgentDirectory", () => {
  it("returns empty string when only current agent exists", () => {
    const agents = [makeAgent("assistant", "Default assistant")];
    expect(buildAgentDirectory(agents, "assistant")).toBe("");
  });

  it("lists other agents excluding current", () => {
    const agents = [
      makeAgent("assistant", "Default assistant"),
      makeAgent("reviewer", "Reviews pull requests"),
      makeAgent("researcher", "Deep research agent"),
    ];
    const result = buildAgentDirectory(agents, "assistant");
    expect(result).toContain("## Available Agents");
    expect(result).toContain("**reviewer**: Reviews pull requests");
    expect(result).toContain("**researcher**: Deep research agent");
    expect(result).not.toContain("**assistant**");
  });

  it("returns empty string when no agents registered", () => {
    expect(buildAgentDirectory([], "assistant")).toBe("");
  });

  it("shows all agents when current agent is not in the list", () => {
    const agents = [
      makeAgent("reviewer", "Reviews PRs"),
      makeAgent("researcher", "Research agent"),
    ];
    const result = buildAgentDirectory(agents, "unknown");
    expect(result).toContain("**reviewer**");
    expect(result).toContain("**researcher**");
  });

  it("includes delegation instructions when delegation is enabled", () => {
    const agents = [
      makeAgent("assistant", "Default"),
      makeAgent("reviewer", "Reviews PRs"),
    ];
    const result = buildAgentDirectory(agents, "assistant", true);
    expect(result).toContain("### Delegation");
    expect(result).toContain("```delegate");
    expect(result).toContain("targetAgent");
  });

  it("omits delegation instructions when delegation is disabled", () => {
    const agents = [
      makeAgent("assistant", "Default"),
      makeAgent("reviewer", "Reviews PRs"),
    ];
    const result = buildAgentDirectory(agents, "assistant", false);
    expect(result).not.toContain("### Delegation");
  });
});

describe("parseDelegationBlocks", () => {
  it("parses a valid delegation block", () => {
    const response = `Here is my analysis.

\`\`\`delegate
{"targetAgent": "reviewer", "message": "Review this PR", "context": "PR #42"}
\`\`\`

Let me know if you need more.`;

    const delegations = parseDelegationBlocks(response);
    expect(delegations).toHaveLength(1);
    expect(delegations[0].targetAgent).toBe("reviewer");
    expect(delegations[0].message).toBe("Review this PR");
    expect(delegations[0].context).toBe("PR #42");
  });

  it("parses delegation without context", () => {
    const response = `\`\`\`delegate
{"targetAgent": "researcher", "message": "Find info on topic X"}
\`\`\``;

    const delegations = parseDelegationBlocks(response);
    expect(delegations).toHaveLength(1);
    expect(delegations[0].targetAgent).toBe("researcher");
    expect(delegations[0].message).toBe("Find info on topic X");
    expect(delegations[0].context).toBeUndefined();
  });

  it("returns empty array for no delegation blocks", () => {
    const response = "Just a regular response with no delegation.";
    expect(parseDelegationBlocks(response)).toEqual([]);
  });

  it("skips malformed JSON in delegation blocks", () => {
    const response = `\`\`\`delegate
not valid json
\`\`\``;

    expect(parseDelegationBlocks(response)).toEqual([]);
  });

  it("skips blocks missing required fields", () => {
    const response = `\`\`\`delegate
{"context": "only context, no target or message"}
\`\`\``;

    expect(parseDelegationBlocks(response)).toEqual([]);
  });

  it("parses multiple delegation blocks", () => {
    const response = `\`\`\`delegate
{"targetAgent": "a", "message": "task 1"}
\`\`\`

\`\`\`delegate
{"targetAgent": "b", "message": "task 2"}
\`\`\``;

    const delegations = parseDelegationBlocks(response);
    expect(delegations).toHaveLength(2);
    expect(delegations[0].targetAgent).toBe("a");
    expect(delegations[1].targetAgent).toBe("b");
  });

  it("does not match regular code blocks", () => {
    const response = `\`\`\`json
{"targetAgent": "reviewer", "message": "not a delegation"}
\`\`\``;

    expect(parseDelegationBlocks(response)).toEqual([]);
  });
});
