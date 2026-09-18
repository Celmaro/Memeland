/**
 * Modal/Button/SelectMenu interaction handlers — extracted from interaction-handler.ts.
 */
import {
  ModalSubmitInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import { OpenCatzHub, OpenCatHub } from '../../orchestrator/hub.js';
import { createDashboardComponents } from '../embeds/dashboard-embed.js';
import { globalRiskEngineV2 } from '../../orchestrator/risk-engine-v2.js';
import { EVMTradeAdapter } from '../../adapters/evm-adapter.js';
import { executeMemeBuy } from '../../services/approval-execution.js';
import { priceAlertService, walletService, tradeJournalService, approvalQueueService, buildDashboardOptions } from './command-handlers.js';

export async function handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (interaction.customId === 'wallet_setup_modal') {
    const pk = interaction.fields.getTextInputValue('wallet_pk').trim();

    const chainType = 'evm';
    walletService.setKey(chainType, pk);

    let addressStr = '';
    try {
      addressStr = `\n• Public Address: \`${walletService.getAddress(chainType)}\``;
    } catch (e: any) {
      addressStr = `\n⚠️ Key stored, but address derivation warning: ${e.message}`;
    }

    await interaction.reply({
      content:
        `🔑 **OpenCatz Burner Wallet Stored!**\n` +
        `• Chain Type: \`${chainType.toUpperCase()}\`${addressStr}\n` +
        `• Security: 🔒 Stored locally in memory & local StateStore.\n` +
        `• Mode: Active for \`${process.env.DRY_RUN === 'false' ? 'LIVE BROADCASTING' : 'DRY_RUN SIMULATION'}\``,
      ephemeral: true,
    });
    return;
  } else if (interaction.customId === 'api_setup_modal') {
    const openseaKey = interaction.fields.getTextInputValue('opensea_key');

    if (openseaKey) process.env.OPENSEA_API_KEY = openseaKey.trim();

    await interaction.reply({
      content:
        `⚙️ **API Keys Successfully Configured!**\n` +
        `• **OpenSea API:** ${openseaKey ? '`🟢 CONFIGURED`' : '`⚪ UNCHANGED`'}\n` +
        `API configuration updated in runtime memory!`,
      ephemeral: true,
    });
  }
}

export async function handleSelectMenu(interaction: StringSelectMenuInteraction, hub: OpenCatzHub): Promise<void> {
  if (interaction.customId === 'select_toggle_agent') {
    const selectedAgent = interaction.values[0];
    const currentState = hub.isAgentActive(selectedAgent);
    const newState = !currentState;
    hub.setAgentActive(selectedAgent, newState);

    const dash = createDashboardComponents(hub, await buildDashboardOptions());
    await interaction.update(dash);
  }
}

export async function handleButtonPress(interaction: ButtonInteraction, hub: OpenCatzHub): Promise<void> {
  const customId = interaction.customId;

  if (customId === 'btn_setup_api_keys') {
    const modal = new ModalBuilder()
      .setCustomId('api_setup_modal')
      .setTitle('⚙️ OpenCatz API Key Setup');

    const openseaInput = new TextInputBuilder()
      .setCustomId('opensea_key')
      .setLabel('OpenSea API Key (EVM NFT Data)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Paste your OpenSea API Key...')
      .setRequired(false);

    const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(openseaInput);
    modal.addComponents(row1);

    await interaction.showModal(modal);
    return;
  }

  if (customId === 'btn_start_all_agents') {
    hub.setAllAgentsActive(true);
    const dash = createDashboardComponents(hub, await buildDashboardOptions());
    await interaction.update(dash);
  } else if (customId === 'btn_pause_all_agents') {
    hub.setAllAgentsActive(false);
    const dash = createDashboardComponents(hub, await buildDashboardOptions());
    await interaction.update(dash);
  } else if (customId === 'btn_emergency_stop') {
    hub.setAllAgentsActive(false);
    await interaction.reply({ content: '🛑 **EMERGENCY CIRCUIT BREAKER TRIGGERED!** All sub-agents paused & pending orders halted.', ephemeral: false });
  } else if (customId === 'btn_view_wallets') {
    const eth = await walletService.getEvmBalance(4663);
    const ethStr = eth ? `${eth.balance.toFixed(4)} ETH${eth.simulated ? ' (Simulated)' : ''}` : '— (unavailable)';
    await interaction.reply({ content: `🔑 **Burner Wallets:** Robinhood (ETH): \`${ethStr}\`.`, ephemeral: true });
  } else if (customId === 'btn_view_alerts') {
    const alerts = priceAlertService.listAlerts(interaction.user.id);
    const count = alerts.length;
    await interaction.reply({ content: `🔔 **Active Price Alerts:** You have \`${count}\` active price alerts set. Use \`/alert list\` to view.`, ephemeral: true });
  } else if (customId === 'btn_refresh_dashboard') {
    const dash = createDashboardComponents(hub, await buildDashboardOptions());
    await interaction.update(dash);
  } else if (customId.startsWith('start_channel_')) {
    const domain = customId.replace('start_channel_', '');
    hub.toggleChannelScreening(interaction.channelId, domain, true);
    await interaction.reply({ content: `⚡ **Channel Screening Activated** for domain: \`${domain}\` in <#${interaction.channelId}>! Sub-agent active.`, ephemeral: false });
  } else if (customId.startsWith('pause_channel_')) {
    const domain = customId.replace('pause_channel_', '');
    hub.toggleChannelScreening(interaction.channelId, domain, false);
    await interaction.reply({ content: `⏸️ **Channel Screening Paused** for domain: \`${domain}\` in <#${interaction.channelId}>. Sub-agent paused.`, ephemeral: false });
  } else if (customId.startsWith('trigger_pass_')) {
    const domain = customId.replace('trigger_pass_', '');
    await interaction.deferReply({ ephemeral: false });
    const results = await hub.triggerAgentPass(domain);
    await interaction.editReply(`🔎 **On-Demand Screening Pass Triggered** for domain \`${domain}\`! Audited ${results.length} candidate signals.`);
  } else if (customId.startsWith('APPROVE_')) {
    const orderId = customId.slice('APPROVE_'.length);
    const order = approvalQueueService.getById(orderId);
    if (!order) {
      await interaction.reply({ content: '❌ Approval order not found.', ephemeral: true });
      return;
    }
    const approved = approvalQueueService.approve(orderId, interaction.user.username || interaction.user.id);
    if (!approved) {
      await interaction.reply({ content: `ℹ️ Order \`${orderId}\` was already decided (status: ${order.status}).`, ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: false });

    // Fail-closed: even an operator-approved fill stays behind the risk gate
    // (drawdown cap / kill-switch). Nothing executes if risk says no.
    const autoExec = hub.isAutoExecuteEnabled('meme-robinhood');
    const amountEth = autoExec.maxTradeAmount || 0.1;
    const riskCheck = hub.getRiskManager().isTradeAllowed(amountEth);
    if (!riskCheck.allowed || globalRiskEngineV2.checkKillSwitchStatus()) {
      await interaction.editReply(
        `🚫 **RISK GATE BLOCKED** approval for \`${approved.symbol}\` — ${riskCheck.allowed ? 'emergency kill-switch active' : riskCheck.reason}`
      );
      return;
    }

    try {
      const res = await executeMemeBuy({
        evm: new EVMTradeAdapter(),
        wallet: walletService,
        journal: tradeJournalService,
        onExecuted: () => approvalQueueService.recordExecuted(approved.id),
        chain: approved.chain,
        symbol: approved.symbol,
        contractAddress: approved.contractAddress,
        entryPriceUsd: approved.entryPriceUsd,
        amountEth,
        confidence: approved.confidence,
        thesis: approved.thesis,
      });
      await interaction.editReply(
        `✅ **APPROVED & EXECUTED** \`${approved.symbol}\` (\`${orderId}\`)\n` +
        `• Result: ${res.success ? (res.simulated ? '🟡 SIMULATED ok' : '🟢 LIVE ok') : '🔴 FAILED'}\n` +
        `• Output: \`${res.outputTokens}\`${res.error ? `\n• Error: \`${res.error}\`` : ''}`
      );
    } catch (err: any) {
      await interaction.editReply(`❌ **APPROVED FILL ERROR** \`${approved.symbol}\`: ${err.message}`);
    }
  } else if (customId.startsWith('CANCEL_')) {
    const orderId = customId.slice('CANCEL_'.length);
    const order = approvalQueueService.getById(orderId);
    const rejected = approvalQueueService.reject(orderId, interaction.user.username || interaction.user.id);
    if (!rejected) {
      await interaction.reply({
        content: `ℹ️ Order \`${orderId}\` was already decided${order ? ` (status: ${order.status})` : ' or does not exist'}.`,
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({ content: `🚫 **CANCELLED** approval for \`${rejected.symbol}\` (\`${orderId}\`).`, ephemeral: false });
  }

}
