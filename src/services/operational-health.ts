import type { OperationalFunnelCounters } from './operational-funnel.js';
import type { AlertPayload, AlertType } from '../notifications/alert-type.js';

export interface ProviderStatus {
  name: string;
  ok: boolean;
  lastSuccessAt?: number;
  lastError?: string;
  rateLimit?: {
    remaining: number;
    resetMs?: number;
  };
  keyRotation?: {
    poolSize: number;
    activeIndex: number;
    lastRotatedAt?: number;
  };
}

export interface SchedulerStatus {
  name: string;
  running: boolean;
  lastStartedAt?: number;
  lastCompletedAt?: number;
  lastError?: string;
}

export interface DeliveryStatus {
  discord: boolean;
  telegram: boolean;
  lastDiscordAt?: number;
  lastTelegramAt?: number;
  lastError?: string;
}

export interface OperationalHealthSnapshot {
  providers: ProviderStatus[];
  scheduler: SchedulerStatus[];
  workerFailures: Array<{ worker: string; reason: string; at: number }>;
  delivery: DeliveryStatus;
  killSwitch: { active: boolean; activatedAt?: number | null };
  funnel: OperationalFunnelCounters;
  alerts: AlertPayload[];
  timestamp: string;
}

/**
 * Lightweight "monitor the monitor" registry. It receives pings from startup,
 * the screening loop, and provider wrappers so the REST health surface can show
 * one coherent operational picture without changing execution behavior.
 */
export class OperationalHealthRegistry {
  private providers = new Map<string, ProviderStatus>();
  private schedulerStatuses = new Map<string, SchedulerStatus>();
  private workerFailures: Array<{ worker: string; reason: string; at: number }> = [];
  private delivery: DeliveryStatus = { discord: false, telegram: false };
  private killSwitch = { active: false, activatedAt: null as number | null };
  private funnel: OperationalFunnelCounters = {
    sourcesQueried: 0,
    candidatesDiscovered: 0,
    candidatesNormalized: 0,
    candidatesEnriched: 0,
    candidatesRejectedByGate: 0,
    signalsEmitted: 0,
    positionsMonitored: 0,
  };
  private alerts: AlertPayload[] = [];
  private readonly maxAlerts = 100;

  public recordProviderRequest(
    name: string,
    ok: boolean,
    extra?: { rateLimit?: ProviderStatus['rateLimit']; keyRotation?: ProviderStatus['keyRotation']; error?: string }
  ): void {
    const current = this.providers.get(name) || { name, ok };
    if (ok) {
      current.ok = true;
      current.lastSuccessAt = Date.now();
      current.lastError = undefined;
    } else {
      current.ok = false;
      current.lastError = extra?.error || 'request failed';
    }
    if (extra?.rateLimit) current.rateLimit = extra.rateLimit;
    if (extra?.keyRotation) current.keyRotation = extra.keyRotation;
    this.providers.set(name, current);
  }

  public setSchedulerStatus(status: SchedulerStatus): void {
    this.schedulerStatuses.set(status.name, status);
  }

  public clearSchedulerStatuses(): void {
    this.schedulerStatuses.clear();
  }

  public recordWorkerFailure(worker: string, reason: string, at = Date.now()): void {
    this.workerFailures.push({ worker, reason, at });
  }

  public clearWorkerFailures(): void {
    this.workerFailures = [];
  }

  public setDelivery(delivery: Partial<DeliveryStatus>): void {
    this.delivery = { ...this.delivery, ...delivery };
  }

  public setKillSwitch(active: boolean, activatedAt: number | null = null): void {
    this.killSwitch = { active, activatedAt };
  }

  public setFunnel(funnel: OperationalFunnelCounters): void {
    this.funnel = { ...funnel };
  }

  public mergeFunnel(funnel: Partial<OperationalFunnelCounters>): void {
    for (const key of Object.keys(funnel) as Array<keyof OperationalFunnelCounters>) {
      this.funnel[key] += Math.max(0, funnel[key] || 0);
    }
  }

  public recordAlert(type: AlertType, title: string, body?: string, at = new Date().toISOString()): void {
    this.alerts.push({ type, title, body, at });
    if (this.alerts.length > this.maxAlerts) {
      this.alerts = this.alerts.slice(this.alerts.length - this.maxAlerts);
    }
  }

  /** Reset runtime telemetry. Used by tests and operator restart flows. */
  public reset(): void {
    this.providers.clear();
    this.schedulerStatuses.clear();
    this.workerFailures = [];
    this.delivery = { discord: false, telegram: false };
    this.killSwitch = { active: false, activatedAt: null };
    this.funnel = {
      sourcesQueried: 0,
      candidatesDiscovered: 0,
      candidatesNormalized: 0,
      candidatesEnriched: 0,
      candidatesRejectedByGate: 0,
      signalsEmitted: 0,
      positionsMonitored: 0,
    };
    this.alerts = [];
  }

  public snapshot(): OperationalHealthSnapshot {
    return {
      providers: Array.from(this.providers.values()),
      scheduler: Array.from(this.schedulerStatuses.values()),
      workerFailures: [...this.workerFailures],
      delivery: { ...this.delivery },
      killSwitch: { ...this.killSwitch },
      funnel: { ...this.funnel },
      alerts: [...this.alerts],
      timestamp: new Date().toISOString(),
    };
  }
}

export const globalOperationalHealth = new OperationalHealthRegistry();
