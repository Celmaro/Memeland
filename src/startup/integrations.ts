import path from 'path';
import { REST, Routes } from 'discord.js';
import { bootstrapDiscordChannels } from '../discord/setup/channel-bootstrap.js';
import { slashCommands } from '../discord/commands/index.js';
import type { TelegramService } from '../telegram/telegram-service.js';
import type { OpenCatzHub } from '../orchestrator/hub.js';
import type { WalletService } from '../services/wallet-service.js';
import type { AIService } from '../services/ai-service.js';

export interface DiscordStartupContext {
  client: any;
  discordToken: string;
  clientId: string;
  telegramService: TelegramService;
  hub: OpenCatzHub;
  walletService: WalletService;
  aiService: AIService;
}

/**
 * Discord/Telegram startup integration: update report forwarding, channel and
 * slash-command bootstrap, and Telegram topic provisioning all live here so the
 * composition root stays focused on orchestration rather than provider setup.
 */
export async function runDiscordStartupIntegrations(ctx: DiscordStartupContext): Promise<void> {
  const { client, discordToken, clientId, telegramService, hub, walletService, aiService } = ctx;

  // Post-update report: forward a saved self-update report once after restart.
  try {
    const fs = await import('fs');
    const reportPath = path.join(process.cwd(), 'database', 'last_update_report.json');
    if (fs.existsSync(reportPath)) {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      fs.unlinkSync(reportPath);
      const stepLines = (report.steps || []).map((s: { label: string; ok: boolean }) => `• **${s.label}:** ${s.ok ? '✅' : '❌'}`).join('\n');
      const restartLine = report.restartOk
        ? '🔄 **PM2 agent restarted — new code is live.**'
        : '⚠ **PM2 restart failed** — run `opencatz deploy` manually.';
      const controlRoomId = process.env.DISCORD_CHANNEL_CONTROL_ROOM;
      const channel = controlRoomId
        ? client.channels.cache.get(controlRoomId)
        : client.channels.cache.find((c: any) => c.name === 'opencatz-control-room' || c.name === 'opencat-control-room');
      if (channel && 'send' in channel) {
        await channel.send(
          `${report.ok ? '✅' : '❌'} **OpenCatz Self-Update ${report.ok ? 'Complete' : 'FAILED'}**\n\n` +
          `${stepLines}\n${restartLine}`
        );
        console.log('[UPDATE REPORT] Update report sent to control room.');
      }
    }
  } catch (reportErr: any) {
    console.warn(`[UPDATE REPORT] Failed to send report: ${reportErr.message}`);
  }

  // Auto-bootstrap Discord category and channels.
  const firstGuild = client.guilds?.cache?.first();
  if (firstGuild) {
    try {
      await bootstrapDiscordChannels(firstGuild);
    } catch (err) {
      console.error('[DISCORD BOOTSTRAP] Channel auto-creation error:', err);
    }
  }

  // Register slash commands.
  try {
    const rest = new REST({ version: '10' }).setToken(discordToken);
    console.log('[DISCORD REST] Registering Slash Commands...');
    await rest.put(Routes.applicationCommands(clientId), {
      body: slashCommands.map(cmd => cmd.toJSON()),
    });
    console.log('[DISCORD REST] Slash Commands registered successfully!');
  } catch (error) {
    console.error('[DISCORD REST] Error registering Slash Commands:', error);
  }

  // Auto-bootstrap Telegram topics and broadcast control menu if configured.
  if (telegramService.isEnabled()) {
    console.log('[TELEGRAM SERVICE] Telegram Notification Bridge Connected! Provisioning Topics & broadcasting control menu...');
    try {
      await telegramService.bootstrapTelegramTopics();
      await telegramService.broadcastInteractiveMenu(hub, walletService);
      telegramService.startPolling(hub, walletService, aiService);
    } catch (tgErr: any) {
      console.error('[TELEGRAM SERVICE] Startup broadcast error:', tgErr.message);
    }
  }
}

/** Identify audit/control-room channels for message routing (kept here as a startup concern). */
export function isControlRoomChannel(configuredId: string | undefined, message: any): boolean {
  if (configuredId && configuredId !== '000000000000000000') {
    return message.channelId === configuredId;
  }
  const chName = (message.channel?.name || '').toLowerCase();
  return chName === 'opencatz-control-room' || chName === 'opencat-control-room';
}
