// Workspace management — creates, registers, and lists workspaces
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync } from "node:fs";
import path from "node:path";
import {
  MICLAW_HOME,
  WORKSPACES_DIR,
  REGISTRY_PATH,
  DAEMON_LOGS_DIR,
  BASE_WEB_PORT,
  type WorkspaceEntry,
  type WorkspaceRegistry,
} from "./types.js";
import { getPackageDir } from "../config.js";

function ensureDirs(): void {
  mkdirSync(MICLAW_HOME, { recursive: true });
  mkdirSync(WORKSPACES_DIR, { recursive: true });
  mkdirSync(DAEMON_LOGS_DIR, { recursive: true });
}

function loadRegistry(): WorkspaceRegistry {
  if (!existsSync(REGISTRY_PATH)) {
    return { version: 1, workspaces: {} };
  }
  try {
    const data = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
    if (!data || typeof data !== "object" || !data.workspaces) {
      console.warn("[workspace] Corrupted registry, resetting");
      return { version: 1, workspaces: {} };
    }
    return data as WorkspaceRegistry;
  } catch (err) {
    console.warn(`[workspace] Failed to parse registry: ${err}. Resetting.`);
    return { version: 1, workspaces: {} };
  }
}

function saveRegistry(registry: WorkspaceRegistry): void {
  ensureDirs();
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
}

function nextAvailablePort(registry: WorkspaceRegistry): number {
  const usedPorts = new Set(
    Object.values(registry.workspaces).map((w) => w.webPort),
  );
  let port = BASE_WEB_PORT;
  while (usedPorts.has(port)) {
    port++;
  }
  return port;
}

export function initWorkspace(
  name: string,
  opts?: { path?: string },
): WorkspaceEntry {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(
      `Invalid workspace name "${name}". Use alphanumeric, dash, or underscore.`,
    );
  }

  const registry = loadRegistry();
  if (registry.workspaces[name]) {
    throw new Error(`Workspace "${name}" already exists at ${registry.workspaces[name].path}`);
  }

  const workspacePath = opts?.path
    ? path.resolve(opts.path)
    : path.join(WORKSPACES_DIR, name);

  if (existsSync(workspacePath) && readDirEntries(workspacePath).length > 0) {
    throw new Error(`Directory "${workspacePath}" already exists and is not empty.`);
  }

  const port = nextAvailablePort(registry);
  const pkgDir = getPackageDir();

  // Create workspace structure
  mkdirSync(workspacePath, { recursive: true });

  // Copy soul files (use package defaults as template)
  const soulSrc = path.join(pkgDir, "soul");
  const soulDst = path.join(workspacePath, "soul");
  if (existsSync(soulSrc)) {
    cpSync(soulSrc, soulDst, { recursive: true });
  } else {
    // Generate from setup defaults if soul dir doesn't exist
    mkdirSync(soulDst, { recursive: true });
    writeDefaultSoulFiles(soulDst, name);
  }

  // Copy skills directory
  const skillsSrc = path.join(pkgDir, "skills");
  const skillsDst = path.join(workspacePath, "skills");
  if (existsSync(skillsSrc)) {
    cpSync(skillsSrc, skillsDst, { recursive: true });
  } else {
    mkdirSync(skillsDst, { recursive: true });
  }

  // Create empty directories
  mkdirSync(path.join(workspacePath, "memory"), { recursive: true });
  mkdirSync(path.join(workspacePath, "sessions"), { recursive: true });
  mkdirSync(path.join(workspacePath, "logs"), { recursive: true });

  // Copy cron jobs or create default
  const cronSrc = path.join(pkgDir, "cron");
  const cronDst = path.join(workspacePath, "cron");
  if (existsSync(cronSrc)) {
    cpSync(cronSrc, cronDst, { recursive: true });
  } else {
    mkdirSync(cronDst, { recursive: true });
    writeFileSync(path.join(cronDst, "jobs.json"), "[]\n");
  }

  // Create empty MEMORY.md
  writeFileSync(path.join(workspacePath, "memory", "MEMORY.md"), "# Memory\n");

  // Generate miclaw.json for this workspace:
  // - Web enabled on 127.0.0.1 with auto-assigned port
  // - CLI disabled (daemon manages the process)
  const config = {
    defaultAgent: "assistant",
    defaultModel: "sonnet",
    soulDir: "./soul",
    skillsDir: "./skills",
    memoryDir: "./memory",
    sessionsDir: "./sessions",
    journalDays: 3,
    promptMode: "append",
    mcpConfig: null,
    permissionMode: "default",
    maxConcurrentProcesses: 5,
    maxQueueDepth: 20,
    maxTurnsPerSession: 20,
    sessionTtlDays: 30,
    channels: {
      cli: {
        enabled: false,
        security: {
          allowedPaths: [workspacePath],
        },
      },
      web: {
        enabled: true,
        port,
        host: "127.0.0.1",
        auth: { type: "none" },
        security: {
          allowedPaths: [workspacePath],
        },
      },
    },
    cron: {
      enabled: true,
      jobsFile: "./cron/jobs.json",
    },
    learning: {
      enabled: true,
      model: "haiku",
      afterEveryTurn: true,
      consolidationCron: "0 2 * * *",
      maxLearningEntries: 200,
    },
    tunnel: {
      enabled: false,
      mode: "quick",
    },
  };

  writeFileSync(
    path.join(workspacePath, "miclaw.json"),
    JSON.stringify(config, null, 2) + "\n",
  );

  // Register workspace
  const entry: WorkspaceEntry = {
    name,
    path: workspacePath,
    webPort: port,
    createdAt: new Date().toISOString(),
    configFile: "miclaw.json",
  };

  registry.workspaces[name] = entry;
  saveRegistry(registry);

  return entry;
}

export function getWorkspace(name: string): WorkspaceEntry | undefined {
  const registry = loadRegistry();
  return registry.workspaces[name];
}

export function listWorkspaces(): WorkspaceEntry[] {
  const registry = loadRegistry();
  return Object.values(registry.workspaces);
}

export function removeWorkspace(name: string): boolean {
  const registry = loadRegistry();
  if (!registry.workspaces[name]) return false;
  delete registry.workspaces[name];
  saveRegistry(registry);
  return true;
}

// ─── Helpers ────────────────────────────────────────────────

function readDirEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function writeDefaultSoulFiles(soulDir: string, agentName: string): void {
  writeFileSync(
    path.join(soulDir, "AGENTS.md"),
    `You are ${agentName}, a personal AI assistant.

You run as a persistent agent that can be reached through multiple channels (CLI, web chat, and scheduled tasks). You maintain memory across conversations and learn from interactions over time.

Your capabilities include:
- Reading and writing files
- Searching codebases
- Running shell commands
- Web search and fetch
- Any tools provided by configured MCP servers

When the user gives you feedback about preferences or corrections, acknowledge it and adapt accordingly. Your memory and learnings are updated automatically — you don't need to manage them manually.
`,
  );

  writeFileSync(
    path.join(soulDir, "SOUL.md"),
    `You are direct and concise. You lead with the answer, not the reasoning.

Style:
- Short sentences. No filler words.
- Use code examples when they clarify things faster than prose.
- Don't repeat back what the user said — just do the thing.
- Don't add disclaimers or caveats unless they're genuinely important.
- Don't use emoji unless asked.

When unsure, ask one focused question rather than guessing. When the task is clear, execute without asking for permission.
`,
  );
}
