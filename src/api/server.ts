import http from 'node:http';
import { OpenCatHub } from '../orchestrator/hub.js';
import { globalHealthWatcher } from '../services/health-watcher.js';
import { globalMarketRegimeFilter } from '../services/market-regime.js';
import { globalRiskEngineV2 } from '../orchestrator/risk-engine-v2.js';
import { tradeJournalService } from '../discord/handlers/command-handlers.js';
import { globalStateStore } from '../services/state-store.js';
import { getExecutionMode } from '../config/config.js';
import { AGENT_DOMAINS } from '../orchestrator/agent-registry.js';
import { ToolRegistry } from '../orchestrator/tool-registry.js';
import { globalOperationalHealth } from '../services/operational-health.js';
import { funnelCountersFromState } from '../services/operational-funnel.js';

export class OpenCatzRESTServer {
  private server: http.Server | null = null;
  private port: number;
  private host: string;
  private toolRegistry = new ToolRegistry();

  constructor(port = 3000) {
    this.port = Number(process.env.API_PORT) || port;
    // Bind to loopback by default; the REST surface can mutate state / execute
    // command tools, so it must not be exposed on all interfaces unintentionally.
    this.host = process.env.API_BIND_HOST || '127.0.0.1';

    // Refuse non-loopback binding unless an API key is configured. Read and
    // control endpoints are only authenticated when a key is present, so a
    // remote bind with no key would otherwise expose trading state and the
    // /api/agents/toggle mutation to the world. Fail startup loudly instead.
    const isLoopback = this.host === '127.0.0.1' || this.host === 'localhost' || this.host === '::1';
    const authKey = (
      process.env.OPENCATZ_API_KEY ||
      process.env.OPENCAT_API_KEY ||
      ''
    ).trim();
    if (!isLoopback && !authKey) {
      throw new Error(
        `API_BIND_HOST=${this.host} is non-loopback — OPENCATZ_API_KEY (or OPENCAT_API_KEY) is required before remote exposure.`
      );
    }
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });
  }

  public start(hub: OpenCatHub): void {
    this.toolRegistry.attachOrchestrator(hub);

    this.server = http.createServer(async (req, res) => {
      const origin = req.headers.origin;
      const allowedOrigins = (process.env.API_ALLOWED_ORIGINS || '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
      const isAllowedOrigin =
        allowedOrigins.length === 0 || (origin !== undefined && allowedOrigins.includes(origin));
      // Set CORS Headers for website integration. Only echo an explicit origin
      // (from API_ALLOWED_ORIGINS); never emit the wildcard `*`, which would let
      // any origin read authenticated responses and mutate state.
      if (allowedOrigins.length === 0) {
        // No allowlist configured → deny cross-origin browser access entirely
        // (loopback dashboards work same-origin / via API calls, not browser CORS).
        res.setHeader('Access-Control-Allow-Origin', '');
      } else if (isAllowedOrigin && origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      } else {
        res.statusCode = 403;
        res.end(JSON.stringify({ success: false, error: 'Forbidden: origin not allowed' }));
        return;
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-OpenCatz-Api-Key, X-OpenCat-Api-Key');
      res.setHeader('Content-Type', 'application/json');

      // Handle CORS Preflight
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      // API Key Authentication Guard — applied to EVERY endpoint (read and
      // write). When no key is configured the server is loopback-bound only
      // (enforced in the constructor), so unauthenticated reads are contained.
      const authKey = process.env.OPENCATZ_API_KEY || process.env.OPENCAT_API_KEY;
      if (authKey && authKey.trim() !== '') {
        const clientKey = req.headers['x-opencatz-api-key'] || req.headers['x-opencat-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
        if (clientKey !== authKey.trim()) {
          res.statusCode = 401;
          res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid or missing API Key' }));
          return;
        }
      }

      const urlObj = new URL(req.url || '/', `http://localhost:${this.port}`);
      const pathname = urlObj.pathname;

      try {
        // 1. GET /health or /api/status (Full system status & setup overview)
        if (req.method === 'GET' && (pathname === '/health' || pathname === '/api/status')) {
          const health = globalHealthWatcher.auditSystemHealth();
          const regime = globalMarketRegimeFilter.getRegime();
          const isKillSwitch = globalRiskEngineV2.checkKillSwitchStatus();
          const ops = globalOperationalHealth.snapshot();

          const subAgents = AGENT_DOMAINS.map((d) => ({
            id: d.id,
            name: d.name,
            channel: d.channel,
            active: hub.isAgentActive(d.id),
            category: d.category,
          }));

          res.statusCode = 200;
          res.end(
            JSON.stringify({
              success: true,
              status: isKillSwitch ? 'KILL_SWITCH_LOCKED' : health.allHealthy ? 'HEALTHY' : 'DEGRADED',
              executionMode: getExecutionMode(),
              primaryVenue: 'Uniswap V3 • Robinhood Chain L2 (#4663)',
              activeDomains: hub.getActiveDomains(),
              subAgents,
              marketRegime: regime,
              connectedApiKeys: {
                xApiV2: Boolean(process.env.X_API_BEARER_TOKEN),
                llm: Boolean(process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY),
                gmgn: Boolean(process.env.GMGN_API_KEY),
              },
              subAgentsReport: health.report,
              operational: ops,
              timestamp: new Date().toISOString(),
            })
          );
          return;
        }

        // 1.5 GET /api/ops/health (unified monitor-the-monitor view)
        if (req.method === 'GET' && pathname === '/api/ops/health') {
          const ops = globalOperationalHealth.snapshot();
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              success: true,
              health: ops,
              providers: ops.providers,
              scheduler: ops.scheduler,
              workerFailures: ops.workerFailures,
              delivery: ops.delivery,
              killSwitch: ops.killSwitch,
              funnel: ops.funnel,
              alerts: ops.alerts,
            })
          );
          return;
        }

        // 1.6 GET /api/ops/funnel (seven-stage operational funnel counters)
        if (req.method === 'GET' && pathname === '/api/ops/funnel') {
          const ops = globalOperationalHealth.snapshot();
          const positions = {
            tokens: globalStateStore.getAllPositions().length,
            total: globalStateStore.getAllPositions().length,
          };
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              success: true,
              counters: ops.funnel,
              derivedFromState: funnelCountersFromState(globalStateStore.getFunnelStats()),
              positions,
            })
          );
          return;
        }

        // 2. GET /api/calls (Signal call cards ledger from StateStore)
        if (req.method === 'GET' && pathname === '/api/calls') {
          const limit = Number(urlObj.searchParams.get('limit')) || 50;
          const domain = urlObj.searchParams.get('domain') || undefined;
          const calls = globalStateStore.getSignalLedger(domain, limit);
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, count: calls.length, calls }));
          return;
        }

        // 3. GET /api/positions (Open positions tracking)
        if (req.method === 'GET' && pathname === '/api/positions') {
          const openTokens = globalStateStore.getAllPositions();
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              success: true,
              summary: {
                totalPositions: openTokens.length,
                tokensCount: openTokens.length,
              },
              tokens: openTokens,
              totalCount: openTokens.length,
            })
          );
          return;
        }

        // 4. GET /api/executions (Trade Journal summary & recent executions)
        if (req.method === 'GET' && pathname === '/api/executions') {
          const stats = tradeJournalService.getSummaryStats();
          const entries = tradeJournalService.listTrades();
          const recentTrades = entries.slice(0, 20);
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              success: true,
              analytics: stats,
              stats,
              entries,
              recentTrades,
            })
          );
          return;
        }

        // 5. GET /api/alerts (Custom price alerts)
        if (req.method === 'GET' && pathname === '/api/alerts') {
          const alerts = globalStateStore.getAllAlerts();
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, count: alerts.length, alerts }));
          return;
        }

        // 6. POST /api/agents/toggle (Toggle sub-agent active state)
        if (req.method === 'POST' && pathname === '/api/agents/toggle') {
          const body = await parseJsonBody(req);
          const domain = String(body.domain || '').trim().toLowerCase();
          const active = typeof body.active === 'boolean' ? body.active : undefined;

          if (!domain) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, error: 'Missing required parameter "domain"' }));
            return;
          }

          const currentActive = hub.isAgentActive(domain);
          const targetActive = active !== undefined ? active : !currentActive;
          hub.setAgentActive(domain, targetActive);

          res.statusCode = 200;
          res.end(
            JSON.stringify({
              success: true,
              domain,
              active: targetActive,
              message: `Sub-Agent "${domain}" is now ${targetActive ? 'ACTIVE' : 'PAUSED'}.`,
            })
          );
          return;
        }

        // 7. POST /api/command (Execute ToolRegistry command via REST)
        if (req.method === 'POST' && pathname === '/api/command') {
          // Mutating/control endpoint — always require a valid API key (fail-closed).
          // Without a configured key, /api/command is refused rather than silently
          // exposing command execution (write_strategy_file, read_file, set_api_key...).
          const authKey = process.env.OPENCATZ_API_KEY || process.env.OPENCAT_API_KEY;
          const clientKey = req.headers['x-opencatz-api-key'] || req.headers['x-opencat-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
          if (!authKey || authKey.trim() === '' || clientKey !== authKey) {
            res.statusCode = 401;
            res.end(JSON.stringify({ success: false, error: 'Unauthorized: /api/command requires a valid API key (set OPENCATZ_API_KEY or OPENCAT_API_KEY).' }));
            return;
          }
          const body = await parseJsonBody(req);
          const toolName = String(body.command || body.toolName || '').trim();
          const args = body.args || {};

          if (!toolName) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, error: 'Missing required field "command" or "toolName"' }));
            return;
          }

          const result = await this.toolRegistry.executeToolCall(toolName, args);
          res.statusCode = result.success ? 200 : 400;
          res.end(JSON.stringify(result));
          return;
        }

        // 8. 404 Route Not Found
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, error: `Endpoint "${pathname}" not found.` }));

      } catch (err: unknown) {
        // Log the detailed error server-side, but never leak internal
        // exception messages (filesystem paths, provider details, etc) to the
        // client.
        console.error('[API] Request failed:', err instanceof Error ? err.message : String(err));
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: 'Internal server error' }));
      }
    });

    this.server.listen(this.port, this.host, () => {
      console.log(`📡 🐾 OPENCATZ AI REST API Server listening on ${this.host}:${this.port}`);
    });
  }
}

/** Backward-compatible alias */
export const OpenCatRESTServer = OpenCatzRESTServer;
export type OpenCatRESTServer = OpenCatzRESTServer;

function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let bodyStr = '';
    let bodySize = 0;
    const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error('Request body timed out'));
    }, 15 * 1000);
    req.on('data', (chunk) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_BYTES) {
        clearTimeout(timeout);
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      bodyStr += chunk.toString('utf8');
    });
    req.on('end', () => {
      clearTimeout(timeout);
      try {
        resolve(bodyStr ? JSON.parse(bodyStr) : {});
      } catch (e) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
