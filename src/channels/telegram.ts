// Layer 3: Telegram channel — long-polling bot via node-telegram-bot-api
import TelegramBot from "node-telegram-bot-api";
import type { Channel, MessageHandler } from "../types.js";
import type { MiclawConfig } from "../config.js";

export class TelegramChannel implements Channel {
  readonly name = "telegram";
  private bot: TelegramBot | null = null;
  private handler: MessageHandler | null = null;
  private knownChatIds: Set<string> = new Set();
  private config: MiclawConfig;

  constructor(config: MiclawConfig) {
    this.config = config;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.bot) return;

    const telegramConfig = this.config.channels.telegram;
    if (!telegramConfig.token) {
      throw new Error("[telegram] Bot token is required. Set channels.telegram.token in miclaw.json");
    }

    this.bot = new TelegramBot(telegramConfig.token, { polling: true });

    // Seed knownChatIds from config so send("*") works without inbound messages
    if (telegramConfig.allowedChatIds?.length) {
      for (const id of telegramConfig.allowedChatIds) {
        this.knownChatIds.add(id);
      }
    }

    this.bot.on("message", async (msg) => {
      const chatId = String(msg.chat.id);
      const text = msg.text;

      if (!text) return;

      if (telegramConfig.allowedChatIds?.length) {
        if (!telegramConfig.allowedChatIds.includes(chatId)) {
          console.log(`[telegram] Blocked message from unauthorized chat ${chatId}`);
          await this.bot!.sendMessage(chatId, "Unauthorized. Your chat ID is not in the allowlist.");
          return;
        }
      }

      this.knownChatIds.add(chatId);

      if (!this.handler) {
        console.log("[telegram] No message handler registered");
        return;
      }

      try {
        await this.bot!.sendChatAction(chatId, "typing");

        const result = await this.handler({
          channelId: "telegram",
          userId: chatId,
          message: text,
        });

        await this.sendLongMessage(chatId, result.result);
      } catch (err) {
        console.error(`[telegram] Error handling message: ${err}`);
        await this.bot!.sendMessage(chatId, "An error occurred processing your message.");
      }
    });

    this.bot.on("polling_error", (err) => {
      console.error(`[telegram] Polling error: ${err.message}`);
    });
  }

  async stop(): Promise<void> {
    if (!this.bot) return;
    await this.bot.stopPolling();
    this.bot = null;
  }

  async send(userId: string, message: string): Promise<boolean> {
    if (!this.bot) return false;

    const targets = userId === "*"
      ? [...this.knownChatIds]
      : [userId];

    if (targets.length === 0) return false;

    let sent = false;
    for (const chatId of targets) {
      try {
        await this.sendLongMessage(chatId, message);
        sent = true;
      } catch (err) {
        console.error(`[telegram] Failed to send to ${chatId}: ${err}`);
      }
    }
    return sent;
  }

  private async sendLongMessage(chatId: string, text: string): Promise<void> {
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await this.bot!.sendMessage(chatId, text);
      return;
    }
    for (let i = 0; i < text.length; i += MAX_LENGTH) {
      const chunk = text.slice(i, i + MAX_LENGTH);
      await this.bot!.sendMessage(chatId, chunk);
    }
  }
}
