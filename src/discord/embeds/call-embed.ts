import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { CallCardPayload as CallSignalPayload } from '../../agents/shared/agent-contract.js';

/**
 * Sanitize attacker-controlled token/tweet fields before rendering into Discord
 * embeds. Token names/symbols come from chain data (GMGN/DexScreener) and can
 * contain markdown link syntax, code blocks, or newlines — a crafted symbol
 * could otherwise inject a clickable phishing link or break the embed layout.
 * Removes markdown-significant characters; keeps alphanumerics and common punctuation.
 */
export function sanitizeEmbedField(value: string | undefined | null, maxLen = 200): string {
  if (!value) return '';
  const cleaned = String(value)
    .replace(/[\r\n\t]+/g, ' ')            // collapse newlines/tabs first
    .replace(/https?:\/\/\S+/gi, ' [LINK] ') // strip raw URLs (prevent link injection)
    .replace(/[\[\](){}<>*_`|~\\]/g, '')   // then remove markdown link/code/bold/italic syntax
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
}

/** Encode a symbol safely into a URL query component. */
export function encodeSymbolForUrl(symbol: string | undefined | null): string {
  const clean = sanitizeEmbedField(symbol, 32);
  return encodeURIComponent(clean);
}

export function buildCallEmbed(payload: CallSignalPayload, options: { approvalOrderId?: string } = {}) {
  // OpenCatz Master Color Palette
  const colorMap: Record<CallSignalPayload['domain'], number> = {
    MEME_ROBINHOOD: 0xffb7b2,  // Pastel Pink
    ALPHA_ROBINHOOD: 0xfff59d, // Pastel Yellow
  };

  const confidenceStr = payload.confidenceScore ? `${payload.confidenceScore}% CONFIDENCE` : 'HIGH CONFIDENCE';

  const embed = new EmbedBuilder()
    .setColor(colorMap[payload.domain] || 0xccff00)
    .setTimestamp()
    .setFooter({ text: '🐾 OpenCatz Intelligence System • Robinhood Chain #4663' });

  const buttonsRow = new ActionRowBuilder<ButtonBuilder>();

  // ==========================================
  // DOMAIN: MEME DEX TOKENS (ROBINHOOD / EVM)
  // ==========================================
  const safeTitle = sanitizeEmbedField(payload.title);
  const safeSymbol = sanitizeEmbedField(payload.symbol, 32);
  embed.setTitle(`🐾 OPENCATZ ROBINHOOD MEME CALL: ${safeTitle} ($${safeSymbol}) • [${confidenceStr}]`);

  if (payload.contractAddress) {
    const ageStr = payload.tokenAge ? ` • ⏱️ **Age:** ${payload.tokenAge}` : '';
    embed.addFields({
      name: '📍 Contract Address (CA)',
      value: `\`${payload.contractAddress}\`${ageStr}`,
      inline: false,
    });
  }

  const priceStr = payload.priceUsd ? ` | 💵 **Price:** ${payload.priceUsd}` : '';
  const volStr = (payload.volume5m || payload.volume1h)
    ? `\n📈 **Vol (5m / 1h):** ${payload.volume5m || 'N/A'} / ${payload.volume1h || 'N/A'}`
    : '';
  const txStr = payload.txRatio ? ` | ⚖️ **Tx:** ${payload.txRatio}` : '';

  embed.addFields({
    name: '📊 Market Metrics',
    value: `💰 **MC:** ${payload.marketCap || 'N/A'}${priceStr}\n💧 **Liquidity:** ${payload.liquidity || 'N/A'}${volStr}${txStr}`,
    inline: false,
  });

  const securityParts: string[] = [];
  if (payload.top10Pct) securityParts.push(`👥 **Top 10:** ${payload.top10Pct}`);
  if (payload.devHoldingPct) securityParts.push(`👨‍💻 **Dev:** ${payload.devHoldingPct}`);
  if (payload.sniperPct) securityParts.push(`🐋 **Snipers:** ${payload.sniperPct}`);
  if (payload.bundlerPct) securityParts.push(`🤖 **Bundler:** ${payload.bundlerPct}`);
  if (payload.dexPaidStatus) securityParts.push(`💳 **DEX Paid:** ${payload.dexPaidStatus}`);

  if (securityParts.length > 0) {
    embed.addFields({
      name: '🛡️ Security & Holder Audit',
      value: securityParts.join(' | '),
      inline: false,
    });
  }

  if (payload.smartMoneyInfo) {
    embed.addFields({
      name: '🧠 Smart Money Tracking & AI Consensus',
      value: `${payload.smartMoneyInfo}\n🟢 **Consensus Confidence Score:** **${confidenceStr} (PASSED)**`,
      inline: false,
    });
  }

  if (payload.contractAddress) {
    const ca = payload.contractAddress;
    const gmgnLink = payload.gmgnUrl || `https://gmgn.ai/robinhood/token/${ca}`;
    const dexscreenerLink = payload.dexScreenerUrl || `https://dexscreener.com/robinhood/${ca}`;

    embed.addFields({
      name: '🔗 Independent Verification Links',
      value: `📊 [DexScreener](${dexscreenerLink}) | 📈 [GMGN Chart](${gmgnLink}) | 🐦 [X (Twitter) Search](https://x.com/search?q=%24${encodeSymbolForUrl(payload.symbol)}&src=typed_query)`,
      inline: false,
    });
  }

  embed.addFields({ name: '💡 AI Thesis & Signal Reasoning', value: sanitizeEmbedField(payload.aiThesis, 500), inline: false });

  const uniswapUrl = payload.contractAddress
    ? `https://app.uniswap.org/explore/pools/robinhood/${payload.contractAddress}`
    : 'https://app.uniswap.org/explore/pools/robinhood';
  buttonsRow.addComponents(
    new ButtonBuilder()
      .setLabel('🌐 Trade on Uniswap')
      .setURL(uniswapUrl)
      .setStyle(ButtonStyle.Link),
    new ButtonBuilder()
      .setCustomId('pause_channel_meme-robinhood')
      .setLabel('⏸️ Pause Robinhood Screening')
      .setStyle(ButtonStyle.Secondary)
  );

  if (payload.dexScreenerUrl || payload.contractAddress) {
    const url = payload.dexScreenerUrl || `https://dexscreener.com/robinhood/${payload.contractAddress}`;
    buttonsRow.addComponents(
      new ButtonBuilder()
        .setLabel('📊 Chart on DexScreener')
        .setURL(url)
        .setStyle(ButtonStyle.Link)
    );
  }

  // Phase-2 APPROVAL ladder: when the signal was queued, the card carries
  // one-click Approve/Cancel so the operator can authorize (or kill) the fill.
  if (options.approvalOrderId) {
    buttonsRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`APPROVE_${options.approvalOrderId}`)
        .setLabel('✅ Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`CANCEL_${options.approvalOrderId}`)
        .setLabel('🚫 Cancel')
        .setStyle(ButtonStyle.Danger)
    );
  }

  return { embeds: [embed], components: [buttonsRow] };
}
