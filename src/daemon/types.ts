// Daemon types — no internal imports

// ─── Workspace Registry ───────────────────────────────────

export interface WorkspaceEntry {
  name: string;
  path: string; // absolute path to workspace directory
  webPort: number;
  createdAt: string; // ISO timestamp
  configFile: string; // relative path to miclaw.json within workspace
}

export interface WorkspaceRegistry {
  version: 1;
  workspaces: Record<string, WorkspaceEntry>;
}

// ─── Daemon State ─────────────────────────────────────────

export interface DaemonState {
  pid: number;
  socketPath: string;
  startedAt: string;
  version: string;
}

export interface ManagedInstance {
  name: string;
  pid: number;
  status: "running" | "stopping";
  startedAt: string;
  webPort: number;
  workspacePath: string;
}

export interface InstanceStatus {
  name: string;
  pid: number | null;
  status: "running" | "stopped" | "crashed";
  startedAt: string | null;
  webPort: number;
  workspacePath: string;
  uptime: number | null; // seconds
}

// ─── IPC Protocol ─────────────────────────────────────────

export type DaemonCommand =
  | { type: "start"; name: string }
  | { type: "stop"; name: string }
  | { type: "restart"; name: string }
  | { type: "list" }
  | { type: "status"; name: string }
  | { type: "kill" };

export interface DaemonResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

// ─── Constants ────────────────────────────────────────────

export const MICLAW_HOME = `${process.env.HOME}/.miclaw`;
export const WORKSPACES_DIR = `${MICLAW_HOME}/workspaces`;
export const REGISTRY_PATH = `${MICLAW_HOME}/workspaces.json`;
export const DAEMON_STATE_PATH = `${MICLAW_HOME}/daemon.json`;
export const DAEMON_SOCKET_PATH = `${MICLAW_HOME}/daemon.sock`;
export const DAEMON_LOGS_DIR = `${MICLAW_HOME}/logs`;
export const BASE_WEB_PORT = 3456;
