#!/usr/bin/env node
// Interactive CLI to configure mikeclaw's soul, identity, and tools
import * as readline from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, resolvePath } from "./config.js";

// ─── Defaults ──────────────────────────────────────────────

const DEFAULTS = {
  "AGENTS.md": {
    header: "Agent Role",
    description: "Defines what your agent is and what it can do",
    template: (name: string) =>
`You are ${name}, a personal AI assistant.

You run as a persistent agent that can be reached through multiple channels (CLI, web chat, and scheduled tasks). You maintain memory across conversations and learn from interactions over time.

Your capabilities include:
- Reading and writing files
- Searching codebases
- Running shell commands
- Web search and fetch
- Any tools provided by configured MCP servers

When the user gives you feedback about preferences or corrections, acknowledge it and adapt accordingly. Your memory and learnings are updated automatically — you don't need to manage them manually.`,
  },
  "SOUL.md": {
    header: "Personality",
    description: "Defines tone, style, and personality traits",
    template: () =>
`You are direct and concise. You lead with the answer, not the reasoning.

Style:
- Short sentences. No filler words.
- Use code examples when they clarify things faster than prose.
- Don't repeat back what the user said — just do the thing.
- Don't add disclaimers or caveats unless they're genuinely important.
- Don't use emoji unless asked.

When unsure, ask one focused question rather than guessing. When the task is clear, execute without asking for permission.`,
  },
  "IDENTITY.md": {
    header: "Identity",
    description: "Name, backstory, and long-form identity details (optional)",
    template: (name: string) =>
`Name: ${name}
Created by: (your name or org)

Background:
- Built as a minimal agentic bot framework on top of Claude Code
- Designed to be extended with skills, memory, and multi-agent coordination

Constraints:
- Always be honest about what you can and cannot do
- Never fabricate information — if you don't know, say so
- Respect privacy — don't share information between users`,
  },
  "TOOLS.md": {
    header: "Tool Guidance",
    description: "Custom instructions for how to use specific tools (optional)",
    template: () =>
`When searching code:
- Use Grep for content search, Glob for file patterns
- Prefer reading specific files over broad searches

When using web tools:
- Cite sources when presenting information from web searches
- Prefer authoritative sources over blog posts

When running commands:
- Explain what a command does before running it if the outcome is destructive
- Prefer read-only commands when gathering information`,
  },
  "HEARTBEAT.md": {
    header: "Heartbeat",
    description: "Prompt for periodic check-in cron jobs (optional)",
    template: () =>
`This is a periodic check-in. Review the following:

1. Check if there are any pending tasks or reminders in the memory or journal files.
2. Look at the recent journal entries for any follow-up items.
3. If there's nothing actionable, simply note the check-in time and move on.

Keep the response brief. Only surface items that need attention.`,
  },
};

type FileKey = keyof typeof DEFAULTS;

const FILE_ORDER: FileKey[] = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "TOOLS.md", "HEARTBEAT.md"];
const REQUIRED: FileKey[] = ["AGENTS.md", "SOUL.md"];

// ─── Prompting helpers ─────────────────────────────────────

function createRL(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function printBox(title: string, content: string) {
  const lines = content.split("\n");
  const width = Math.min(Math.max(...lines.map((l) => l.length), title.length + 4), 72);
  const border = "─".repeat(width + 2);
  console.log(`\n┌${border}┐`);
  console.log(`│ \x1b[1m${title.padEnd(width)}\x1b[0m │`);
  console.log(`├${border}┤`);
  for (const line of lines) {
    console.log(`│ ${line.padEnd(width)} │`);
  }
  console.log(`└${border}┘`);
}

function printPreview(content: string, maxLines = 6) {
  const lines = content.split("\n");
  const preview = lines.slice(0, maxLines);
  for (const line of preview) {
    console.log(`  \x1b[90m│\x1b[0m ${line}`);
  }
  if (lines.length > maxLines) {
    console.log(`  \x1b[90m│ ... (${lines.length - maxLines} more lines)\x1b[0m`);
  }
}

// ─── Main setup flow ───────────────────────────────────────

async function setup() {
  const rl = createRL();

  console.log("\n\x1b[1m🔧 mikeclaw setup\x1b[0m");
  console.log("Configure your agent's soul, personality, and behavior.\n");

  // Determine soul directory
  let soulDir: string;
  try {
    const config = loadConfig();
    soulDir = resolvePath(config.soulDir);
  } catch {
    soulDir = resolvePath("./soul");
  }

  // Check for existing files
  const existing = FILE_ORDER.filter((f) => existsSync(path.join(soulDir, f)));
  if (existing.length > 0) {
    console.log(`Found existing soul files in ${soulDir}:`);
    for (const f of existing) {
      const isReq = REQUIRED.includes(f) ? " (required)" : " (optional)";
      console.log(`  \x1b[32m✓\x1b[0m ${f}${isReq}`);
    }
    for (const f of FILE_ORDER.filter((f) => !existing.includes(f))) {
      const isReq = REQUIRED.includes(f) ? " (required)" : " (optional)";
      console.log(`  \x1b[90m○ ${f}${isReq}\x1b[0m`);
    }
    console.log();

    const mode = await ask(rl, "Would you like to (e)dit existing, (r)eset all, or (q)uit? [e/r/q]: ");
    if (mode.toLowerCase() === "q") {
      console.log("Bye!");
      rl.close();
      return;
    }
    if (mode.toLowerCase() !== "r") {
      // Edit mode: only prompt for files user wants to change
      await editMode(rl, soulDir);
      rl.close();
      return;
    }
    console.log("\nResetting all files...\n");
  }

  // Full setup
  mkdirSync(soulDir, { recursive: true });

  // Agent name (used in templates)
  const agentName = await ask(rl, "Agent name [mikeclaw]: ") || "mikeclaw";
  console.log();

  for (const fileKey of FILE_ORDER) {
    const def = DEFAULTS[fileKey];
    const isRequired = REQUIRED.includes(fileKey);
    const filePath = path.join(soulDir, fileKey);

    console.log(`\x1b[1m${def.header}\x1b[0m — ${def.description} \x1b[90m(skip = ${isRequired ? "use default" : "don't create"})\x1b[0m`);

    // Show default preview
    const defaultContent = def.template(agentName);
    console.log("  Default:");
    printPreview(defaultContent);

    const action = await ask(rl, `  (a)ccept default, (c)ustom, or (s)kip? [a/c/s]: `);

    if (action.toLowerCase() === "s") {
      if (isRequired) {
        // Required files get the default when skipped
        writeFileSync(filePath, defaultContent + "\n");
        console.log(`  \x1b[90mSkipped — wrote default for ${fileKey}\x1b[0m\n`);
      } else {
        console.log(`  \x1b[90mSkipped ${fileKey}\x1b[0m\n`);
      }
      continue;
    }

    if (action.toLowerCase() === "c") {
      console.log(`  Enter content for ${fileKey} (empty line + Enter to finish):`);
      const customContent = await readMultiline(rl);
      if (customContent.trim().length === 0) {
        console.log("  \x1b[33mEmpty input — using default\x1b[0m");
        writeFileSync(filePath, defaultContent + "\n");
      } else {
        writeFileSync(filePath, customContent + "\n");
      }
    } else {
      writeFileSync(filePath, defaultContent + "\n");
    }

    console.log(`  \x1b[32m✓\x1b[0m Wrote ${fileKey}\n`);
  }

  // Summary
  console.log("\x1b[1m✓ Setup complete!\x1b[0m\n");
  console.log(`Soul files in: ${soulDir}`);
  for (const f of FILE_ORDER) {
    const fp = path.join(soulDir, f);
    if (existsSync(fp)) {
      const size = readFileSync(fp, "utf-8").length;
      console.log(`  \x1b[32m✓\x1b[0m ${f} (${size} chars)`);
    } else {
      console.log(`  \x1b[90m○ ${f} (skipped)\x1b[0m`);
    }
  }
  console.log(`\nRun \x1b[1mnpm start\x1b[0m to launch mikeclaw.`);
  rl.close();
}

// ─── Edit mode ─────────────────────────────────────────────

async function editMode(rl: readline.Interface, soulDir: string) {
  console.log("\nSelect a file to edit (or 'done' to finish):\n");

  while (true) {
    for (let i = 0; i < FILE_ORDER.length; i++) {
      const f = FILE_ORDER[i];
      const fp = path.join(soulDir, f);
      const exists = existsSync(fp);
      const status = exists ? "\x1b[32m✓\x1b[0m" : "\x1b[90m○\x1b[0m";
      const sizeInfo = exists ? ` (${readFileSync(fp, "utf-8").trim().length} chars)` : "";
      console.log(`  ${i + 1}. ${status} ${f}${sizeInfo} — ${DEFAULTS[f].description}`);
    }
    console.log(`  0. Done\n`);

    const choice = await ask(rl, "Choose [0-5]: ");
    const idx = parseInt(choice, 10);

    if (isNaN(idx) || idx === 0) {
      console.log("\n\x1b[1m✓ Done editing.\x1b[0m");
      return;
    }

    if (idx < 1 || idx > FILE_ORDER.length) {
      console.log("  Invalid choice.\n");
      continue;
    }

    const fileKey = FILE_ORDER[idx - 1];
    const filePath = path.join(soulDir, fileKey);
    const def = DEFAULTS[fileKey];

    // Show current content if exists
    if (existsSync(filePath)) {
      const current = readFileSync(filePath, "utf-8").trim();
      printBox(`Current ${fileKey}`, current);
    }

    const action = await ask(rl, `  (e)dit, (d)efault, (v)iew default, (r)emove, or (b)ack? `);

    switch (action.toLowerCase()) {
      case "e": {
        console.log(`  Enter new content for ${fileKey} (empty line + Enter to finish):`);
        const content = await readMultiline(rl);
        if (content.trim().length === 0) {
          console.log("  \x1b[33mEmpty — no changes made\x1b[0m\n");
        } else {
          mkdirSync(soulDir, { recursive: true });
          writeFileSync(filePath, content + "\n");
          console.log(`  \x1b[32m✓\x1b[0m Updated ${fileKey}\n`);
        }
        break;
      }
      case "d": {
        const agentName = extractAgentName(soulDir) || "mikeclaw";
        mkdirSync(soulDir, { recursive: true });
        writeFileSync(filePath, def.template(agentName) + "\n");
        console.log(`  \x1b[32m✓\x1b[0m Reset ${fileKey} to default\n`);
        break;
      }
      case "v": {
        const agentName = extractAgentName(soulDir) || "mikeclaw";
        printBox(`Default ${fileKey}`, def.template(agentName));
        console.log();
        break;
      }
      case "r": {
        if (REQUIRED.includes(fileKey)) {
          console.log(`  \x1b[31m✗ Cannot remove required file ${fileKey}\x1b[0m\n`);
        } else if (existsSync(filePath)) {
          const confirm = await ask(rl, `  Are you sure you want to remove ${fileKey}? [y/N]: `);
          if (confirm.toLowerCase() === "y") {
            const { unlinkSync } = await import("node:fs");
            unlinkSync(filePath);
            console.log(`  \x1b[32m✓\x1b[0m Removed ${fileKey}\n`);
          } else {
            console.log("  Cancelled.\n");
          }
        } else {
          console.log(`  ${fileKey} doesn't exist.\n`);
        }
        break;
      }
      default:
        console.log();
        break;
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────

/** Read multiline input until an empty line */
function readMultiline(rl: readline.Interface): Promise<string> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const handler = (line: string) => {
      if (line === "" && lines.length > 0) {
        rl.removeListener("line", handler);
        resolve(lines.join("\n"));
      } else {
        lines.push(line);
      }
    };
    rl.on("line", handler);
  });
}

/** Try to extract agent name from existing AGENTS.md */
function extractAgentName(soulDir: string): string | null {
  const agentsFile = path.join(soulDir, "AGENTS.md");
  if (!existsSync(agentsFile)) return null;
  const content = readFileSync(agentsFile, "utf-8");
  // Look for "You are <name>,"
  const match = content.match(/You are (\w+)/);
  return match?.[1] ?? null;
}

// ─── CLI entry ─────────────────────────────────────────────

const command = process.argv[2];

if (command === "setup" || command === "configure" || command === "init" || !command) {
  setup().catch((err) => {
    console.error(`Error: ${err}`);
    process.exit(1);
  });
} else if (command === "show") {
  // Quick view of current soul
  let soulDir: string;
  try {
    const config = loadConfig();
    soulDir = resolvePath(config.soulDir);
  } catch {
    soulDir = resolvePath("./soul");
  }

  console.log(`\n\x1b[1mSoul files\x1b[0m (${soulDir}):\n`);
  for (const f of FILE_ORDER) {
    const fp = path.join(soulDir, f);
    if (existsSync(fp)) {
      const content = readFileSync(fp, "utf-8").trim();
      const lines = content.split("\n").length;
      printBox(`${f} (${content.length} chars, ${lines} lines)`, content);
    } else {
      console.log(`\x1b[90m  ○ ${f} — not configured\x1b[0m`);
    }
  }
  console.log();
} else if (command === "help" || command === "--help" || command === "-h") {
  console.log(`
\x1b[1mmikeclaw setup\x1b[0m — Configure your agent's soul

Usage:
  npx tsx src/setup.ts              Interactive setup (same as 'setup')
  npx tsx src/setup.ts setup        Interactive setup wizard
  npx tsx src/setup.ts show         View current soul configuration
  npx tsx src/setup.ts help         Show this help

Or via npm scripts:
  npm run setup                     Interactive setup
  npm run setup:show                View current configuration

Files configured:
  AGENTS.md     Agent role and capabilities (required)
  SOUL.md       Personality and tone (required)
  IDENTITY.md   Name, backstory, constraints (optional)
  TOOLS.md      Custom tool usage guidance (optional)
  HEARTBEAT.md  Periodic check-in prompt (optional)
`);
} else {
  console.error(`Unknown command: ${command}. Run with 'help' for usage.`);
  process.exit(1);
}
