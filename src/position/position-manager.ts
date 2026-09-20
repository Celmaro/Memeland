import { StateStore } from '../services/state-store.js';
import { OpportunityLedger } from '../services/opportunity-ledger.js';

export interface OpenPosition {
  id: string;
  symbol: string;
  contractAddress: string;
  entryPriceUsd: number;
  currentPriceUsd: number;
  amount: number;
  highWaterMarkUsd: number;
  initialVolume4hUsd?: number;
  initialSmartMoneyCount?: number;
  tp100Triggered?: boolean;
  tp200Triggered?: boolean;
  /** Current stop-loss magnitude (0.5 = -50%). Tightened on smart-money exit. */
  stopLossPct?: number;
}

export interface ActiveLPPosition {
  id: string; // poolAddress
  poolAddress: string;
  pairName: string;
  network: 'Robinhood';
  isOutOfRange: boolean;
  currentVolumeToActiveTvl4h: number;
  currentVolumeToTvl4h?: number;
  currentFeesToTvlRatio4h: number;
  currentOrganicVolumeScore4h: number;
}

export interface ActiveNFTPosition {
  id: string; // collectionSlug_tokenId
  collectionSlug: string;
  collectionName: string;
  tokenId: string;
  entryFloorEth: number;
  currentFloorEth: number;
  highestFloorEth: number;
  salesVelocity1h: number;
  tp30Triggered?: boolean;
  tp50Triggered?: boolean;
}

/**
 * PR12.c (SRC-209 vegapunk): graceful-exit helpers — a TP scale-out ladder and
 * a refined stop-loss that tightens as the high-water mark rises but never
 * loosens below a protective floor. Pure and fail-closed on invalid inputs.
 */

export interface TPLadderStep {
  /** Price multiplier above entry at which this step triggers. */
  targetMultiplier: number;
  /** Fraction of the position to scale out at this step. */
  scaleOutFraction: number;
}

export interface TPLadderResult {
  triggered: TPLadderStep[];
  totalScaleOutFraction: number;
  remainingFraction: number;
}

export const DEFAULT_TP_LADDER: TPLadderStep[] = [
  { targetMultiplier: 2, scaleOutFraction: 0.5 },
  { targetMultiplier: 3, scaleOutFraction: 0.5 },
];

/**
 * Compute the scale-out plan from a TP ladder. Steps must be sorted ascending
 * by targetMultiplier; every triggered step's scale-out fraction is summed.
 * Degenerate input yields an empty plan (never over-sells).
 */
export function tpLadderExit(
  entryPriceUsd: number,
  currentPriceUsd: number,
  steps: TPLadderStep[] = DEFAULT_TP_LADDER,
): TPLadderResult {
  const ordered = (Array.isArray(steps) ? steps : [])
    .filter(
      (s) =>
        Number.isFinite(s.targetMultiplier) &&
        s.targetMultiplier > 1 &&
        Number.isFinite(s.scaleOutFraction) &&
        s.scaleOutFraction >= 0 &&
        s.scaleOutFraction <= 1,
    )
    .sort((a, b) => a.targetMultiplier - b.targetMultiplier);
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) {
    return { triggered: [], totalScaleOutFraction: 0, remainingFraction: 1 };
  }
  if (!Number.isFinite(currentPriceUsd) || currentPriceUsd < entryPriceUsd) {
    return { triggered: [], totalScaleOutFraction: 0, remainingFraction: 1 };
  }
  const multiple = currentPriceUsd / entryPriceUsd;
  const triggered = ordered.filter((s) => multiple >= s.targetMultiplier);
  const total = Math.min(1, triggered.reduce((a, s) => a + s.scaleOutFraction, 0));
  return { triggered, totalScaleOutFraction: total, remainingFraction: 1 - total };
}

export interface RefinedStopResult {
  stopPriceUsd: number;
  /** Stop distance below current highest price, as a fraction. */
  trailPct: number;
  /** Stop distance below entry, as a fraction (0.5 = -50%). */
  protectionPct: number;
  reason: string;
}

/**
 * Refined stop-loss: the tighter of the high-water-mark trail and the entry
 * protection floor, so gains are locked without ever loosening the downside
 * protection. Returns null on invalid input (fail-closed).
 */
export function refinedStopLoss(
  entryPriceUsd: number,
  highestPriceUsd: number,
  protectivePct = 0.5,
  trailPct = 0.35,
): RefinedStopResult | null {
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) return null;
  if (!Number.isFinite(highestPriceUsd) || highestPriceUsd < entryPriceUsd) return null;
  if (!Number.isFinite(protectivePct) || protectivePct < 0 || protectivePct > 1) return null;
  if (!Number.isFinite(trailPct) || trailPct < 0 || trailPct > 1) return null;

  const protectiveStop = entryPriceUsd * (1 - protectivePct);
  const trailStop = highestPriceUsd * (1 - trailPct);
  const stopPriceUsd = Math.max(protectiveStop, trailStop);
  const reason = trailStop > protectiveStop ? 'high-water trail' : 'entry protection floor';
  return {
    stopPriceUsd,
    trailPct,
    protectionPct: protectivePct,
    reason,
  };
}

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TwoCandleAboveResult {
  /** True only when the trailing candles all close above entry (confirming). */
  confirmed: boolean;
  /** Consecutive candle closes above entry, counting back from the latest. */
  consecutiveAbove: number;
  reason: string;
}

/**
 * PR12.d (SRC-219 uerax all-in-one-bot): two-candle-above-entry confirmation
 * rule. A signal/position is only considered confirmed when the most recent
 * candle AND the one before it both close above entry (a win-rate filter that
 * avoids entering into a one-candle pump that immediately fades). Fail-closed:
 * any invalid candle or entry makes `confirmed` false.
 */
export function twoCandleAboveEntry(
  candles: Candle[],
  entryPriceUsd: number,
): TwoCandleAboveResult {
  const list = Array.isArray(candles) ? candles : [];
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) {
    return { confirmed: false, consecutiveAbove: 0, reason: 'invalid entry price' };
  }
  if (list.length === 0) {
    return { confirmed: false, consecutiveAbove: 0, reason: 'no candles to confirm' };
  }
  let consecutiveAbove = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (
      !c ||
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close)
    ) {
      break;
    }
    if (c.close > entryPriceUsd) consecutiveAbove++;
    else break;
  }
  const confirmed = consecutiveAbove >= 2;
  return {
    confirmed,
    consecutiveAbove,
    reason: confirmed
      ? `confirmed by ${consecutiveAbove} consecutive closes above entry`
      : `only ${consecutiveAbove} consecutive close(s) above entry`,
  };
}

export interface HWMHardStopResult {
  stopPriceUsd: number;
  hardStopUsd: number;
  trailStopUsd: number;
  reason: string;
}

/**
 * PR12.h (SRC-067 fdv.lol): high-water-mark trailing hard-stop. The binding
 * stop is the tighter of a fixed hard stop below entry and a trail below the
 * running high-water mark, so a winner never gives back the whole move while
 * the original downside protection still holds. Null on invalid input.
 */
export function highWaterMarkHardStop(
  entryPriceUsd: number,
  currentPriceUsd: number,
  highWaterMarkUsd: number,
  hardStopPct = 0.3,
  trailPct = 0.5,
): HWMHardStopResult | null {
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) return null;
  if (!Number.isFinite(currentPriceUsd) || currentPriceUsd < 0) return null;
  if (!Number.isFinite(highWaterMarkUsd) || highWaterMarkUsd < entryPriceUsd) return null;
  if (!Number.isFinite(hardStopPct) || hardStopPct < 0 || hardStopPct > 1) return null;
  if (!Number.isFinite(trailPct) || trailPct < 0 || trailPct > 1) return null;

  const hwm = Math.max(highWaterMarkUsd, currentPriceUsd);
  const hardStopUsd = entryPriceUsd * (1 - hardStopPct);
  const trailStopUsd = hwm * (1 - trailPct);
  const stopPriceUsd = Math.max(hardStopUsd, trailStopUsd);
  return {
    stopPriceUsd,
    hardStopUsd,
    trailStopUsd,
    reason: trailStopUsd > hardStopUsd ? 'high-water trail' : 'fixed hard stop',
  };
}

export interface ProfitLockResult {
  locked: boolean;
  floorUsd: number | null;
}

/**
 * PR12.h profit-lock floor: once price reaches `lockMultiplier` x entry, a
 * floor is locked at `floorMultiplier` x entry (default break-even), so a
 * winner cannot give the profit back to a crash. Null floor until activated.
 */
export function profitLockFloor(
  entryPriceUsd: number,
  currentPriceUsd: number,
  lockMultiplier = 1.5,
  floorMultiplier = 1.0,
): ProfitLockResult {
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) {
    return { locked: false, floorUsd: null };
  }
  if (!Number.isFinite(currentPriceUsd) || currentPriceUsd < 0) {
    return { locked: false, floorUsd: null };
  }
  if (!Number.isFinite(lockMultiplier) || lockMultiplier < 1) {
    return { locked: false, floorUsd: null };
  }
  if (!Number.isFinite(floorMultiplier) || floorMultiplier < 0) {
    return { locked: false, floorUsd: null };
  }
  if (currentPriceUsd < entryPriceUsd * lockMultiplier) {
    return { locked: false, floorUsd: null };
  }
  return { locked: true, floorUsd: entryPriceUsd * floorMultiplier };
}

/**
 * PR12.h rug blacklist: a fail-closed, in-memory denylist of known-rug
 * identities keyed by `chain:address`. Unknown entries are simply absent (the
 * caller decides how to treat an absent key); `has` never throws.
 */
export class RugBlacklist {
  private readonly entries = new Set<string>();

  add(chain: string, address: string): boolean {
    const key = this.key(chain, address);
    if (this.entries.has(key)) return false;
    this.entries.add(key);
    return true;
  }

  has(chain: string, address: string): boolean {
    return this.entries.has(this.key(chain, address));
  }

  get size(): number {
    return this.entries.size;
  }

  private key(chain: string, address: string): string {
    return `${String(chain || '').toLowerCase()}:${String(address || '').toLowerCase()}`;
  }
}

export class PositionManager {
  private stateStore: StateStore | null = null;
  private opportunityLedger: OpportunityLedger | null = null;

  // In-memory mirrors for fast access (loaded from StateStore on init)
  private activePositions: Map<string, OpenPosition> = new Map();
  private activeLpPositions: Map<string, ActiveLPPosition> = new Map();
  private activeNftPositions: Map<string, ActiveNFTPosition> = new Map();

  /**
   * Attach persistent StateStore. Call this after StateStore is initialized.
   * Loads all existing positions from disk into memory.
   */
  public attachStateStore(store: StateStore): void {
    this.stateStore = store;

    // Restore positions from persistent storage
    for (const pos of store.getAllPositions()) {
      this.activePositions.set(pos.id, pos);
    }
    for (const lp of store.getAllLpPositions()) {
      this.activeLpPositions.set(lp.id, lp);
    }
    for (const nft of store.getAllNftPositions()) {
      this.activeNftPositions.set(nft.id, nft);
    }

    const total = this.activePositions.size + this.activeLpPositions.size + this.activeNftPositions.size;
    if (total > 0) {
      console.log(`[POSITION MANAGER] Restored ${this.activePositions.size} spot, ${this.activeLpPositions.size} LP, ${this.activeNftPositions.size} NFT positions from persistent state.`);
    }
  }

  /**
   * Attach the OpportunityLedger so position open/exit lifecycle events can be
   * recorded (MOVED_TO_OPEN / POSITION_EXITED). Optional — no-op without it.
   */
  public attachOpportunityLedger(ledger: OpportunityLedger): void {
    this.opportunityLedger = ledger;
  }

  // ==========================================
  // MEME & SPOT POSITION TRACKING
  // ==========================================

  public addPosition(position: OpenPosition) {
    this.activePositions.set(position.id, position);
    this.stateStore?.setPosition(position);
    this.emitPositionEvent(position, 'MOVED_TO_OPEN');
  }

  public getActivePositions(): OpenPosition[] {
    return Array.from(this.activePositions.values());
  }

  public removePosition(id: string): void {
    const position = this.activePositions.get(id);
    this.activePositions.delete(id);
    this.stateStore?.removePosition(id);
    if (position) this.emitPositionEvent(position, 'POSITION_EXITED');
  }

  /** Record a lifecycle event for every ledger identity matching this contract. */
  private emitPositionEvent(position: OpenPosition, type: 'MOVED_TO_OPEN' | 'POSITION_EXITED'): void {
    if (!this.opportunityLedger) return;
    const label = type === 'MOVED_TO_OPEN' ? 'opened' : 'exited';
    for (const identity of this.opportunityLedger.findByContractAddress(position.contractAddress)) {
      this.opportunityLedger.recordPositionEvent(
        identity.opportunityId,
        type,
        `position ${position.id} ${label} (${position.symbol})`
      );
    }
  }

  /**
   * Tighten the stop-loss on a HELD meme position (smaller value = tighter SL).
   * Only ever moves the SL narrower — never widens it. Returns false if the
   * position isn't held so callers can degrade gracefully.
   */
  public tightenStopLoss(contractAddress: string, stopPercent: number): boolean {
    const pos = Array.from(this.activePositions.values()).find(
      (p) => p.contractAddress.toLowerCase() === String(contractAddress || '').toLowerCase()
    );
    if (!pos) return false;
    const current = pos.stopLossPct ?? 0.5;
    pos.stopLossPct = Math.min(current, stopPercent);
    this.stateStore?.setPosition(pos);
    return true;
  }

  public updateMemePosition(
    positionId: string,
    currentPriceUsd: number,
    currentVolume4hUsd?: number,
    currentSmartMoneyCount?: number
  ): { triggerAlert: boolean; type: 'MILESTONE' | 'WARNING' | 'CRITICAL' | 'NONE'; reason?: string } {
    const pos = this.activePositions.get(positionId);
    if (!pos) return { triggerAlert: false, type: 'NONE' };

    pos.currentPriceUsd = currentPriceUsd;
    if (currentPriceUsd > pos.highWaterMarkUsd) {
      pos.highWaterMarkUsd = currentPriceUsd;
    }

    const priceChangePercent = ((currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;

    // 1. Take Profit Milestones (+100% and +200%)
    if (priceChangePercent >= 200 && !pos.tp200Triggered) {
      pos.tp200Triggered = true;
      this.stateStore?.setPosition(pos);
      return {
        triggerAlert: true,
        type: 'MILESTONE',
        reason: `🟢 **TP2 Milestone Reached:** $${pos.symbol} has surged **+200% (3x)** from entry! Current Price: $${currentPriceUsd.toFixed(6)}. High-profit taking recommended!`,
      };
    }

    if (priceChangePercent >= 100 && !pos.tp100Triggered) {
      pos.tp100Triggered = true;
      this.stateStore?.setPosition(pos);
      return {
        triggerAlert: true,
        type: 'MILESTONE',
        reason: `🟢 **TP1 Milestone Reached:** $${pos.symbol} has surged **+100% (2x)** from entry! Current Price: $${currentPriceUsd.toFixed(6)}. Secure 50% of capital!`,
      };
    }

    // 2. Critical Drop (default -50%; tightened by a smart-money exit, e.g. -20%)
    const stopLossPct = pos.stopLossPct ?? 0.5;
    if (priceChangePercent <= -stopLossPct * 100) {
      this.stateStore?.setPosition(pos);
      return {
        triggerAlert: true,
        type: 'CRITICAL',
        reason: `🚨 **Critical Drop:** $${pos.symbol} has dropped **-${Math.round(stopLossPct * 100)}%** below your entry price! Current Price: $${currentPriceUsd.toFixed(6)}. Immediate exit recommended!`,
      };
    }

    // 3. Significant Volume Drop (> 70% decrease relative to entry)
    if (pos.initialVolume4hUsd && currentVolume4hUsd) {
      const volumeDropPercent = ((pos.initialVolume4hUsd - currentVolume4hUsd) / pos.initialVolume4hUsd) * 100;
      if (volumeDropPercent >= 70) {
        this.stateStore?.setPosition(pos);
        return {
          triggerAlert: true,
          type: 'WARNING',
          reason: `⚠️ **Volume Dry-up Warning:** $${pos.symbol} volume has dropped by **${volumeDropPercent.toFixed(1)}%** (from $${pos.initialVolume4hUsd.toLocaleString()} to $${currentVolume4hUsd.toLocaleString()}). Liquidity is fading!`,
        };
      }
    }

    // 4. Smart Money Exiting (Count drops below 1, or drops by >= 50%)
    if (pos.initialSmartMoneyCount !== undefined && currentSmartMoneyCount !== undefined) {
      if (currentSmartMoneyCount === 0 || (pos.initialSmartMoneyCount >= 2 && currentSmartMoneyCount <= pos.initialSmartMoneyCount * 0.5)) {
        this.stateStore?.setPosition(pos);
        return {
          triggerAlert: true,
          type: 'CRITICAL',
          reason: `🚨 **Smart Money Exited:** Smart Money wallets holding $${pos.symbol} dropped from **${pos.initialSmartMoneyCount}** to **${currentSmartMoneyCount}**! Insiders are dumping!`,
        };
      }
    }

    // Persist updated price even if no alert
    this.stateStore?.setPosition(pos);
    return { triggerAlert: false, type: 'NONE' };
  }

  // ==========================================
  // CONCENTRATED LP POSITION TRACKING
  // ==========================================

  public addLpPosition(position: ActiveLPPosition) {
    this.activeLpPositions.set(position.id, position);
    this.stateStore?.setLpPosition(position);
  }

  public getActiveLpPositions(): ActiveLPPosition[] {
    return Array.from(this.activeLpPositions.values());
  }

  public removeLpPosition(id: string): void {
    this.activeLpPositions.delete(id);
    this.stateStore?.removeLpPosition(id);
  }

  public checkLpPositionAlert(positionId: string): { triggerAlert: boolean; reason?: string } {
    const pos = this.activeLpPositions.get(positionId);
    if (!pos) return { triggerAlert: false };

    if (pos.isOutOfRange) {
      return {
        triggerAlert: true,
        reason: `🚨 **Out of Range Alert:** Price has moved outside of your active LP bins for ${pos.pairName}. Fees are no longer accumulating! Time to re-range or exit.`,
      };
    }

    if (pos.currentOrganicVolumeScore4h < 65) {
      return {
        triggerAlert: true,
        reason: `🎣 **Organic Volume Warning:** Organic activity score on ${pos.pairName} dropped to **${pos.currentOrganicVolumeScore4h}/100**. Suspicious wash-trading or liquidity pull detected.`,
      };
    }

    if (pos.currentFeesToTvlRatio4h < 0.05) {
      return {
        triggerAlert: true,
        reason: `💸 **Yield Velocity Warning:** LP fee yield on ${pos.pairName} dropped to **${(pos.currentFeesToTvlRatio4h * 100).toFixed(2)}%** per 4h (below the 5.0% Trade+LP target). Consider withdrawing LP!`,
      };
    }

    if (pos.currentVolumeToTvl4h !== undefined && pos.currentVolumeToTvl4h < 1.5) {
      return {
        triggerAlert: true,
        reason: `📉 **Volume Turnover Alert:** Total pool volume turnover on ${pos.pairName} fell to **${(pos.currentVolumeToTvl4h * 100).toFixed(0)}%** (below 150% 4h target). Trading momentum is fading!`,
      };
    }

    if (pos.currentVolumeToActiveTvl4h < 6.0) {
      return {
        triggerAlert: true,
        reason: `⚡ **Active Velocity Alert:** Capital turnover in active LP range for ${pos.pairName} fell to **${pos.currentVolumeToActiveTvl4h.toFixed(1)}x** (below 6.0x target). Active bin volume slowing down.`,
      };
    }

    return { triggerAlert: false };
  }

  // ==========================================
  // ACTIVE NFT POSITION TRACKING & ALERTS
  // ==========================================

  public addNftPosition(position: ActiveNFTPosition) {
    this.activeNftPositions.set(position.id, position);
    this.stateStore?.setNftPosition(position);
  }

  public getActiveNftPositions(): ActiveNFTPosition[] {
    return Array.from(this.activeNftPositions.values());
  }

  public removeNftPosition(id: string): void {
    this.activeNftPositions.delete(id);
    this.stateStore?.removeNftPosition(id);
  }

  /**
   * Updates & checks active NFT position for TP milestones (+30%, +50%), floor drops (-20%), or volume momentum dry-up
   */
  public updateNftPosition(
    positionId: string,
    currentFloorEth: number,
    salesVelocity1h: number
  ): { triggerAlert: boolean; type: 'MILESTONE' | 'WARNING' | 'CRITICAL' | 'NONE'; reason?: string } {
    const pos = this.activeNftPositions.get(positionId);
    if (!pos) return { triggerAlert: false, type: 'NONE' };

    pos.currentFloorEth = currentFloorEth;
    pos.salesVelocity1h = salesVelocity1h;
    if (currentFloorEth > pos.highestFloorEth) {
      pos.highestFloorEth = currentFloorEth;
    }

    const floorChangePct = ((currentFloorEth - pos.entryFloorEth) / pos.entryFloorEth) * 100;

    // 1. Take Profit Milestones (+50% and +30%)
    if (floorChangePct >= 50 && !pos.tp50Triggered) {
      pos.tp50Triggered = true;
      this.stateStore?.setNftPosition(pos);
      return {
        triggerAlert: true,
        type: 'MILESTONE',
        reason: `🟢 **NFT TP2 MILESTONE (+50%):** Floor price for **${pos.collectionName} #${pos.tokenId}** surged +50%! (Entry: \`${pos.entryFloorEth} ETH\` ➡️ Current Floor: \`${currentFloorEth} ETH\`). High-profit taking recommended!`,
      };
    }

    if (floorChangePct >= 30 && !pos.tp30Triggered) {
      pos.tp30Triggered = true;
      this.stateStore?.setNftPosition(pos);
      return {
        triggerAlert: true,
        type: 'MILESTONE',
        reason: `🟢 **NFT TP1 MILESTONE (+30%):** Floor price for **${pos.collectionName} #${pos.tokenId}** surged +30%! (Entry: \`${pos.entryFloorEth} ETH\` ➡️ Current Floor: \`${currentFloorEth} ETH\`). Consider listing at floor to secure profits!`,
      };
    }

    // 2. Critical Floor Drop (-20%)
    if (floorChangePct <= -20) {
      this.stateStore?.setNftPosition(pos);
      return {
        triggerAlert: true,
        type: 'CRITICAL',
        reason: `🚨 **NFT FLOOR DROP WARNING (-20%):** Floor price for **${pos.collectionName} #${pos.tokenId}** dropped -20% below your entry! (Entry: \`${pos.entryFloorEth} ETH\` ➡️ Current Floor: \`${currentFloorEth} ETH\`). Cut-loss recommended!`,
      };
    }

    // 3. Sales Velocity Dry-up Alert (Sales velocity < 5 sales/hour)
    if (salesVelocity1h < 5) {
      this.stateStore?.setNftPosition(pos);
      return {
        triggerAlert: true,
        type: 'WARNING',
        reason: `⚠️ **NFT MOMENTUM FADING:** Sales velocity for **${pos.collectionName}** dropped to \`${salesVelocity1h} sales/hour\` (below 5 sales/h threshold). Trading volume momentum is fading!`,
      };
    }

    this.stateStore?.setNftPosition(pos);
    return { triggerAlert: false, type: 'NONE' };
  }
}
