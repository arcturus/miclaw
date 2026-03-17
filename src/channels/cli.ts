// Layer 3: CLI REPL channel
import { createInterface, type Interface } from "node:readline";
import type { Channel, MessageHandler } from "../types.js";

export class CLIChannel implements Channel {
  readonly name = "cli";
  private rl: Interface | null = null;
  private handler: MessageHandler | null = null;
  private prompt: string;

  constructor(prompt: string = "you> ") {
    this.prompt = prompt;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.rl) return;

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    console.log("\n🤖 mikeclaw — Type a message to chat. Ctrl+C to exit.\n");

    const askQuestion = () => {
      this.rl?.question(this.prompt, async (input) => {
        const message = input.trim();
        if (!message) {
          askQuestion();
          return;
        }

        if (message === "/quit" || message === "/exit") {
          await this.stop();
          process.exit(0);
        }

        if (!this.handler) {
          console.log("[cli] No message handler registered");
          askQuestion();
          return;
        }

        try {
          console.log("\n⏳ Thinking...\n");
          const result = await this.handler({
            channelId: "cli",
            userId: "local",
            message,
          });
          console.log(`${result.result}\n`);
          if (result.cost) {
            console.log(`  [$${result.cost.toFixed(4)} | ${(result.durationMs / 1000).toFixed(1)}s]\n`);
          }
        } catch (err) {
          console.error(`\n❌ Error: ${err}\n`);
        }

        askQuestion();
      });
    };

    askQuestion();
  }

  async stop(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  async send(userId: string, message: string): Promise<boolean> {
    console.log(`\n📢 [broadcast] ${message}\n`);
    return true;
  }
}
