#!/usr/bin/env node
// Layer 3: Entry point — wires everything together
import { loadConfig, resolvePath } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { CLIChannel } from "./channels/cli.js";
import { WebChannel } from "./channels/web.js";
import { CronScheduler } from "./cron.js";
import { readFileSync, existsSync } from "node:fs";
import type { Channel, AgentConfig } from "./types.js";

async function main() {
  console.log("mikeclaw v0.1.0\n");

  // Load config
  const configPath = process.argv[2];
  const config = loadConfig(configPath);

  // Create orchestrator
  const orchestrator = new Orchestrator(config);

  // Load agents if agents.json exists
  const agentsFile = resolvePath("agents.json");
  if (existsSync(agentsFile)) {
    try {
      const raw = readFileSync(agentsFile, "utf-8");
      const agents: Record<string, Omit<AgentConfig, "id">> = JSON.parse(raw);
      for (const [id, agent] of Object.entries(agents)) {
        orchestrator.registerAgent({ id, ...agent } as AgentConfig);
      }
      console.log(`[agents] Loaded ${Object.keys(agents).length} agents`);
    } catch (err) {
      console.warn(`[agents] Error loading agents.json: ${err}`);
    }
  }

  // Register default agent only if not already defined in agents.json
  if (orchestrator.getAgents().every((a) => a.id !== "assistant")) {
    orchestrator.registerAgent({
      id: "assistant",
      description: "Default assistant",
      soulDir: config.soulDir,
      skills: [],
    });
  }

  // Collect active channels for broadcast routing
  const channels: Map<string, Channel> = new Map();

  // Start channels
  if (config.channels.cli.enabled) {
    const cli = new CLIChannel(config.channels.cli.prompt);
    cli.onMessage((input) => orchestrator.handleMessage(input));
    channels.set("cli", cli);
  }

  // Start cron scheduler (create before web so we can inject it)
  let cronScheduler: CronScheduler | null = null;
  if (config.cron.enabled) {
    const broadcastCallback = async (channelName: string, userId: string, message: string) => {
      const channel = channels.get(channelName);
      if (channel) {
        await channel.send(userId, message);
      } else {
        console.warn(`[cron] Broadcast target channel "${channelName}" not found`);
      }
    };
    cronScheduler = new CronScheduler(orchestrator, config, broadcastCallback);
    cronScheduler.start();
  }

  if (config.channels.web.enabled) {
    const web = new WebChannel(config);
    web.onMessage((input) => orchestrator.handleMessage(input));
    web.setOrchestrator(orchestrator);
    if (cronScheduler) web.setCronScheduler(cronScheduler);
    channels.set("web", web);
  }

  // Start all channels
  for (const [name, channel] of channels) {
    await channel.start();
    console.log(`[${name}] Channel started`);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    cronScheduler?.stop();
    for (const [name, channel] of channels) {
      await channel.stop();
    }
    orchestrator.getSessionManager().flush();
    console.log("Goodbye!");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
