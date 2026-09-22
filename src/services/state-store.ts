import fs from 'fs';
import path from 'path';
import { atomicWriteJsonSync } from '../storage/atomic-file-store.js';
import { OpenPosition } from '../position/position-manager.js';
import { PriceAlert } from './price-alert-service.js';
import { TradeJournalEntry } from './trade-journal-service.js';

/**
 * Signal Ledger Entry — immutable audit trail for every signal evaluated by Swarm Consensus
 */
export interface SignalLedgerEntry {
  id: string;
  timestamp: string;
  sourceAgent: string;
  domain: string;
  symbol: string;
  contractAddress: string;
  quantScore: number;
  catalystScore: number;
  securityScore: number;
  totalConfidence: number;
  passed: boolean;
  reason: string;
  rawPayloadJson: string;
}

/**
 * Phase-1 scorecard entry (Arch 5 ladder) — predicted-vs-actual for every fired
 * signal. Fired signals get an OPEN entry at their quoted entry price; the
 * screening cycle updates prices each pass and flips status on TP(+100%)/SL(-50%)
 * to mirror real position-manager closes.
 */
export interface ScorecardEntry {
  id: string;
  symbol: string;
  chain: string;
  contractAddress: string;
  confidence: number;
  entryPriceUsd: number;
  currentPriceUsd: number;
  entryTimestampIso: string;
  updatedAtIso: string;
  status: 'OPEN' | 'TP' | 'SL' | 'CLOSED';
}

/**
 * Phase-2 approval order (Arch 5 ladder) — a gate-passed signal queued for
 * one-click operator approve/cancel. Approved fills are what unlock Phase-3 AUTO
 * (N approved + positive expectancy).
 */
export interface ApprovalOrder {
  id: string;
  domain: string;
  symbol: string;
  contractAddress: string;
  chain: string;
  entryPriceUsd: number;
  suggestedSizeUsd: number;
  confidence: number;
  thesis: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAtIso: string;
  decidedAtIso?: string;
  decidedBy?: string;
  scorecardId?: string;
}

/**
 * Token tracked by the wallet auto-tracker — resolved on startup via GMGN token info.
 */
export interface TrackedToken {
  chain: string;
  address: string;
  symbol: string;
  addedAt: number;
}

/**
 * Full OpenCatz persisted state — survives bot restarts
 */
export interface OpenCatzPersistedState {
  // Core position tracking
  openPositions: Record<string, OpenPosition>;

  // Services state
  priceAlerts: Record<string, PriceAlert>;
  tradeJournalEntries: Record<string, TradeJournalEntry>;

  // Persistent Wallet Private Key (survives process restarts and git updates)
  walletKeys: {
    evmPrivateKey?: string;
  };

  // Agent on/off states
  agentStates: Record<string, boolean>;

  // Signal audit ledger (append-only)
  signalLedger: SignalLedgerEntry[];

  // Persistent signal dedup (survives restarts)
  dedupEntries: Record<string, number>;

  // Wallet auto-tracking targets (survives restarts)
  trackedTokens: TrackedToken[];

  // Per-domain runtime screening config overrides (set via chat tool; merged
  // over agent defaults at startup). Plain JSON-safe key/value — validation
  // happens in the agents (whitelist + clamps) before persisting.
  screeningConfigs: Record<string, Record<string, unknown>>;

  // Phase-1 funnel counters per domain+stage (scanned/prefiltered/consensus/fired/executed)
  funnels: Record<string, Record<string, number>>;

  // Phase-1 predicted-vs-actual scorecard (Arch 5 ladder)
  scorecard: ScorecardEntry[];

  // Phase-2 approval queue (Arch 5 ladder) — gate-passed signals awaiting operator decision
  approvalOrders: ApprovalOrder[];

  // Metadata
  lastUpdated: string;
  version: number;
}
export type OpenCatPersistedState = OpenCatzPersistedState;

const CURRENT_VERSION = 2;

export class StateStore {
  private dbFilePath: string;
  private state: OpenCatzPersistedState;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 1000; // coalesce rapid writes into 1 disk write per second

  constructor(filePath?: string) {
    const dbDir = path.resolve(process.cwd(), 'database');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    const defaultNewPath = path.join(dbDir, 'opencatz_state.json');
    const legacyPath = path.join(dbDir, 'opencat_state.json');

    if (filePath) {
      this.dbFilePath = filePath;
    } else {
      if (!fs.existsSync(defaultNewPath) && fs.existsSync(legacyPath)) {
        try {
          fs.copyFileSync(legacyPath, defaultNewPath);
          console.log(`[STATE STORE] Auto-migrated legacy database/opencat_state.json -> database/opencatz_state.json`);
        } catch {
          // ignore copy error and fallback
        }
      }
      this.dbFilePath = defaultNewPath;
    }

    this.state = this.loadFromDisk();
    this.ensureLatestFields();
    console.log(`[STATE STORE] Loaded persistent state from ${this.dbFilePath} (${this.state.signalLedger.length} ledger entries, ${Object.keys(this.state.priceAlerts).length} alerts, ${Object.keys(this.state.tradeJournalEntries).length} journal entries)`);
  }

  // ==========================================
  // DISK I/O
  // ==========================================

  private createEmptyState(): OpenCatzPersistedState {
    return {
      openPositions: {},
      priceAlerts: {},
      tradeJournalEntries: {},
      walletKeys: {},
      agentStates: {},
      signalLedger: [],
      dedupEntries: {},
      trackedTokens: [],
      screeningConfigs: {},
      funnels: {},
      scorecard: [],
      approvalOrders: [],
      lastUpdated: new Date().toISOString(),
      version: CURRENT_VERSION,
    };
  }

  /** Backfill fields added after the on-disk version — existing state files must never lose data. */
  private ensureLatestFields(): void {
    if (!this.state.funnels) this.state.funnels = {};
    if (!Array.isArray(this.state.scorecard)) this.state.scorecard = [];
    if (!Array.isArray(this.state.approvalOrders)) this.state.approvalOrders = [];
  }

  private loadFromDisk(): OpenCatPersistedState {
    try {
      if (!fs.existsSync(this.dbFilePath)) {
        const initial = this.createEmptyState();
        this.saveToDiskSync(initial);
        return initial;
      }

      const raw = fs.readFileSync(this.dbFilePath, 'utf-8');
      const data = JSON.parse(raw);

      // Migrate from v1 (old DbService format) to v2
      if (!data.version || data.version < CURRENT_VERSION) {
        console.log('[STATE STORE] Migrating state from v1 to v2...');
        const migrated = this.createEmptyState();

        // Preserve old data if it exists
        if (Array.isArray(data.priceAlerts)) {
          for (const a of data.priceAlerts) {
            if (a.id) migrated.priceAlerts[a.id] = a;
          }
        }
        if (Array.isArray(data.tradeJournalEntries)) {
          for (const t of data.tradeJournalEntries) {
            if (t.id) migrated.tradeJournalEntries[t.id] = t;
          }
        }

        this.saveToDiskSync(migrated);
        return migrated;
      }

      return {
        openPositions: data.openPositions || {},
        priceAlerts: data.priceAlerts || {},
        tradeJournalEntries: data.tradeJournalEntries || {},
        // DuckAI P0-1: wallet keys are memory-only — never hydrate from disk.
        // A legacy file may still contain them; ignore it so the key only ever
        // enters via env (EVM_PRIVATE_KEY) or a runtime /wallet command.
        walletKeys: {},
        agentStates: data.agentStates || {},
        signalLedger: Array.isArray(data.signalLedger) ? data.signalLedger : [],
        dedupEntries: data.dedupEntries || {},
        trackedTokens: Array.isArray(data.trackedTokens) ? data.trackedTokens : [],
        screeningConfigs: data.screeningConfigs || {},
        funnels: data.funnels || {},
        scorecard: Array.isArray(data.scorecard) ? data.scorecard : [],
        approvalOrders: Array.isArray(data.approvalOrders) ? data.approvalOrders : [],
        lastUpdated: data.lastUpdated || new Date().toISOString(),
        version: CURRENT_VERSION,
      };
    } catch (err: any) {
      console.error('[STATE STORE ERROR] Failed to load state, starting fresh:', err.message);
      return this.createEmptyState();
    }
  }

  private saveToDiskSync(state: OpenCatPersistedState): void {
    try {
      state.lastUpdated = new Date().toISOString();
      // DuckAI P0-1: never persist wallet keys. Strip before the atomic write so
      // a runtime-set key (e.g. /wallet command) stays memory-only.
      const { walletKeys: _stripped, ...safeState } = state;
      atomicWriteJsonSync(this.dbFilePath, safeState);
    } catch (err: any) {
      console.error('[STATE STORE ERROR] Failed to save state:', err.message);
    }
  }

  /**
   * Debounced save — coalesces rapid mutations into a single disk write per DEBOUNCE_MS window.
   * Prevents disk thrashing during bursts of position updates or alert checks.
   */
  private scheduleSave(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.saveToDiskSync(this.state);
      this.saveDebounceTimer = null;
    }, this.DEBOUNCE_MS);
  }

  /** Force immediate save (use before graceful shutdown) */
  public flushToDisk(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    this.saveToDiskSync(this.state);
  }

  // ==========================================
  // POSITIONS (Meme & Spot)
  // ==========================================

  public setPosition(pos: OpenPosition): void {
    this.state.openPositions[pos.id] = pos;
    this.scheduleSave();
  }

  public removePosition(id: string): boolean {
    const existed = id in this.state.openPositions;
    delete this.state.openPositions[id];
    if (existed) this.scheduleSave();
    return existed;
  }

  public getAllPositions(): OpenPosition[] {
    return Object.values(this.state.openPositions);
  }

  // ==========================================
  // PRICE ALERTS
  // ==========================================

  public setAlert(alert: PriceAlert): void {
    this.state.priceAlerts[alert.id] = alert;
    this.scheduleSave();
  }

  public removeAlert(id: string): boolean {
    const existed = id in this.state.priceAlerts;
    delete this.state.priceAlerts[id];
    if (existed) this.scheduleSave();
    return existed;
  }

  public getAllAlerts(): PriceAlert[] {
    return Object.values(this.state.priceAlerts);
  }

  // ==========================================
  // TRADE JOURNAL
  // ==========================================

  public setJournalEntry(entry: TradeJournalEntry): void {
    this.state.tradeJournalEntries[entry.id] = entry;
    this.scheduleSave();
  }

  public getAllJournalEntries(): TradeJournalEntry[] {
    return Object.values(this.state.tradeJournalEntries);
  }

  // ==========================================
  // WALLET KEYS (Persistent across bot updates)
  // ==========================================

  public setWalletKey(chain: 'evm', privateKey: string): void {
    if (!this.state.walletKeys) this.state.walletKeys = {};
    this.state.walletKeys.evmPrivateKey = privateKey;
    this.scheduleSave();
  }

  public removeWalletKey(chain: 'evm'): void {
    if (this.state.walletKeys) {
      delete this.state.walletKeys.evmPrivateKey;
      this.scheduleSave();
    }
  }

  public getWalletKeys(): { evmPrivateKey?: string } {
    return this.state.walletKeys || {};
  }

  // ==========================================
  // AGENT STATES
  // ==========================================

  public setAgentState(domain: string, active: boolean): void {
    this.state.agentStates[domain] = active;
    this.scheduleSave();
  }

  public getAllAgentStates(): Record<string, boolean> {
    return { ...this.state.agentStates };
  }

  // ==========================================
  // SIGNAL LEDGER (Append-Only Audit Trail)
  // ==========================================

  public appendSignalLedger(entry: SignalLedgerEntry): void {
    this.state.signalLedger.push(entry);

    // Cap ledger at 10,000 entries to prevent unbounded growth
    if (this.state.signalLedger.length > 10000) {
      this.state.signalLedger = this.state.signalLedger.slice(-5000);
    }

    this.scheduleSave();
  }

  public getSignalLedger(domain?: string, limit = 50): SignalLedgerEntry[] {
    let list = this.state.signalLedger || [];
    if (domain) {
      const norm = domain.toLowerCase().trim();
      list = list.filter((e) => e.domain.toLowerCase() === norm || e.sourceAgent.toLowerCase() === norm);
    }
    return list.slice(-limit).reverse();
  }

  // ==========================================
  // PERSISTENT SIGNAL DEDUP
  // ==========================================

  public setDedupEntry(key: string, timestamp: number): void {
    this.state.dedupEntries[key] = timestamp;
    this.scheduleSave();
  }

  public getAllDedupEntries(): Record<string, number> {
    return this.state.dedupEntries;
  }

  // ==========================================
  // TRACKED TOKENS (Wallet Auto-Tracking)
  // ==========================================

  public getTrackedTokens(): TrackedToken[] {
    return this.state.trackedTokens;
  }

  /** Add or update a tracked token, deduped by chain + address (case-insensitive). */
  public setTrackedToken(tok: TrackedToken): void {
    const existing = this.state.trackedTokens.findIndex(
      (t) => t.chain === tok.chain && t.address.toLowerCase() === tok.address.toLowerCase()
    );
    if (existing >= 0) {
      this.state.trackedTokens[existing] = tok;
    } else {
      this.state.trackedTokens.push(tok);
    }
    this.scheduleSave();
  }

  // ==========================================
  // SCREENING CONFIG OVERRIDES (per domain, via chat tool)
  // ==========================================

  public getScreeningConfigs(): Record<string, Record<string, unknown>> {
    return this.state.screeningConfigs;
  }

  /** Merge validated per-domain config overrides into persistent state. */
  public setScreeningConfig(domain: string, partial: Record<string, unknown>): void {
    this.state.screeningConfigs[domain] = { ...(this.state.screeningConfigs[domain] || {}), ...partial };
    this.scheduleSave();
  }

  // ==========================================
  // PHASE-1 FUNNEL COUNTERS + SCORECARD (Arch 5 ladder)
  // ==========================================

  /** Increment a funnel stage counter for a domain. Stages: scanned/prefiltered/consensus/fired/executed/approved. */
  public incrementFunnel(domain: string, stage: string, by = 1): void {
    if (!this.state.funnels[domain]) this.state.funnels[domain] = {};
    this.state.funnels[domain][stage] = (this.state.funnels[domain][stage] || 0) + by;
    this.scheduleSave();
  }

  public getFunnelStats(): Record<string, Record<string, number>> {
    return this.state.funnels;
  }

  /** Open a scorecard entry for a fired signal (predicted-vs-actual tracking). */
  public appendScorecardEntry(entry: ScorecardEntry): void {
    this.state.scorecard.push(entry);
    this.scheduleSave();
  }

  /** Update an OPEN scorecard entry's price; flips to TP (+100%) or SL (-50%) to mirror
   *  how real positions are closed (position-manager TP1 +100% / SL -50%). */
  public updateScorecardPrice(id: string, priceUsd: number, nowIso: string): void {
    const entry = this.state.scorecard.find((e) => e.id === id && e.status === 'OPEN');
    if (!entry || !(priceUsd > 0)) return;
    entry.currentPriceUsd = priceUsd;
    entry.updatedAtIso = nowIso;
    const change = entry.entryPriceUsd > 0 ? priceUsd / entry.entryPriceUsd - 1 : 0;
    if (change >= 1.0) entry.status = 'TP';
    else if (change <= -0.5) entry.status = 'SL';
    this.scheduleSave();
  }

  public getScorecard(): ScorecardEntry[] {
    return this.state.scorecard;
  }

  // ==========================================
  // PHASE-2 APPROVAL QUEUE (Arch 5 ladder)
  // ==========================================

  public getApprovalOrders(): ApprovalOrder[] {
    return this.state.approvalOrders;
  }

  public getApprovalOrder(id: string): ApprovalOrder | undefined {
    return this.state.approvalOrders.find((o) => o.id === id);
  }

  /** Insert a new approval order at the front of the queue. */
  public addApprovalOrder(order: ApprovalOrder): void {
    this.state.approvalOrders.unshift(order);
    this.scheduleSave();
  }

  /** Upsert an existing approval order (status/decision updates). */
  public updateApprovalOrder(order: ApprovalOrder): void {
    const idx = this.state.approvalOrders.findIndex((o) => o.id === order.id);
    if (idx >= 0) this.state.approvalOrders[idx] = order;
    else this.state.approvalOrders.unshift(order);
    this.scheduleSave();
  }
}

export const globalStateStore = new StateStore();
export const stateStore = globalStateStore;
