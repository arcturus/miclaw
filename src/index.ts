#!/usr/bin/env node
// Layer 3: Entry point — wires everything together
import { loadConfig, resolvePath } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { CLIChannel } from "./channels/cli.js";
import { WebChannel } from "./channels/web.js";
import { TelegramChannel } from "./channels/telegram.js";
import { CronScheduler } from "./cron.js";
import { CloudflareTunnel } from "./tunnel.js";
import { readFileSync, existsSync } from "node:fs";
import type { Channel, AgentConfig } from "./types.js";

async function main() {
  console.log("miclaw v0.1.0\n");

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
      if (channelName === "*") {
        for (const [, channel] of channels) {
          await channel.send(userId, message);
        }
      } else {
        const channel = channels.get(channelName);
        if (channel) {
          await channel.send(userId, message);
        } else {
          console.warn(`[cron] Broadcast target channel "${channelName}" not found`);
        }
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

  if (config.channels.telegram.enabled) {
    const telegram = new TelegramChannel(config);
    telegram.onMessage((input) => orchestrator.handleMessage(input));
    channels.set("telegram", telegram);
  }

  // Start all channels
  for (const [name, channel] of channels) {
    await channel.start();
    console.log(`[${name}] Channel started`);
  }

  // Start Cloudflare Tunnel if enabled
  let tunnel: CloudflareTunnel | null = null;
  if (config.tunnel.enabled && config.channels.web.enabled) {
    tunnel = new CloudflareTunnel(
      config.tunnel,
      config.channels.web.port,
      config.channels.web.host,
    );
    try {
      const info = await tunnel.start();
      console.log(`[tunnel] Public URL: ${info.url}`);
    } catch (err) {
      console.error(`[tunnel] Failed to start: ${err}`);
      console.warn("[tunnel] Continuing without tunnel — web channel is still accessible locally");
      tunnel = null;
    }
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    await tunnel?.stop();
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
