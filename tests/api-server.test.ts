import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OpenCatzRESTServer, OpenCatRESTServer } from '../src/api/server.js';
import { OpenCatzHub, OpenCatHub } from '../src/orchestrator/hub.js';
import { globalOperationalHealth } from '../src/services/operational-health.js';

describe('OpenCatzRESTServer Test Suite', () => {
  let server: OpenCatzRESTServer;
  let hub: OpenCatzHub;
  const testPort = 3199;

  beforeEach(async () => {
    delete process.env.OPENCATZ_API_KEY;
    delete process.env.OPENCAT_API_KEY;
    process.env.API_PORT = String(testPort);
    hub = new OpenCatzHub();
    server = new OpenCatzRESTServer(testPort);
    globalOperationalHealth.reset();
    server.start(hub);
    // Give server a moment to bind
    await new Promise((r) => setTimeout(r, 100));
  });

  afterEach(async () => {
    await server.stop();
  });

  it('GET /api/status returns 200 with full system status and active sub-agent details', async () => {
      const res = await fetch(`http://localhost:${testPort}/api/status`);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.executionMode).toBeDefined();
      expect(data.primaryVenue).toContain('Robinhood Chain L2');
      expect(Array.isArray(data.subAgents)).toBe(true);
      // Arch-3 strip: lp-robinhood + nft + alpha + whale-eth removed; meme (multi-chain) remains.
      expect(data.subAgents.length).toBe(1);
      expect(data.connectedApiKeys).toBeDefined();
    });

  it('GET /api/ops/health returns the unified monitor-the-monitor surface', async () => {
    globalOperationalHealth.recordProviderRequest('gmgn', true, { rateLimit: { remaining: 3 } });
    globalOperationalHealth.setSchedulerStatus({ name: 'screening', running: false, lastCompletedAt: 1 });
    globalOperationalHealth.setDelivery({ discord: true, telegram: true });
    globalOperationalHealth.setKillSwitch(false);
    const res = await fetch(`http://localhost:${testPort}/api/ops/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.health).toBeDefined();
    expect(data.providers.some((p: any) => p.name === 'gmgn')).toBe(true);
    expect(data.scheduler).toEqual([{ name: 'screening', running: false, lastCompletedAt: 1 }]);
    expect(data.delivery).toEqual({ discord: true, telegram: true });
  });

  it('GET /api/ops/funnel returns seven-stage counters plus derived state', async () => {
    globalOperationalHealth.mergeFunnel({ candidatesDiscovered: 4, signalsEmitted: 1 });
    const res = await fetch(`http://localhost:${testPort}/api/ops/funnel`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.counters.candidatesDiscovered).toBe(4);
    expect(data.counters.signalsEmitted).toBe(1);
    expect(data.positions.total).toBeDefined();
    expect(data.derivedFromState).toBeDefined();
  });

  it('GET /api/calls returns signal call ledger items', async () => {
    const res = await fetch(`http://localhost:${testPort}/api/calls`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(Array.isArray(data.calls)).toBe(true);
  });

  it('GET /api/positions returns open token positions', async () => {
    const res = await fetch(`http://localhost:${testPort}/api/positions`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.summary).toBeDefined();
    expect(data.tokens).toBeDefined();
  });

  it('GET /api/executions returns trade journal summary & entries', async () => {
    const res = await fetch(`http://localhost:${testPort}/api/executions`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.analytics).toBeDefined();
    expect(Array.isArray(data.entries)).toBe(true);
  });

  it('POST /api/agents/toggle toggles sub-agent active state', async () => {
    const res = await fetch(`http://localhost:${testPort}/api/agents/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'alpha-robinhood', active: true }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.domain).toBe('alpha-robinhood');
    expect(data.active).toBe(true);
    expect(hub.isAgentActive('alpha-robinhood')).toBe(true);
  });

  it('Enforces OPENCATZ_API_KEY authentication guard when set', async () => {
    process.env.OPENCATZ_API_KEY = 'secret_key_123';

    // 1. Without header -> 401
    const unauthRes = await fetch(`http://localhost:${testPort}/api/status`);
    expect(unauthRes.status).toBe(401);

    // 2. With valid header -> 200
    const authRes = await fetch(`http://localhost:${testPort}/api/status`, {
      headers: { 'X-OpenCatz-Api-Key': 'secret_key_123' },
    });
    expect(authRes.status).toBe(200);
  });

  it('POST /api/command is fail-closed: requires a valid API key', async () => {
    // No key configured -> 401 (command must never run unauthenticated)
    const noKey = await fetch(`http://localhost:${testPort}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'read_file', args: { path: 'package.json' } }),
    });
    expect(noKey.status).toBe(401);

    // Key configured but request missing the header -> 401
    process.env.OPENCATZ_API_KEY = 'secret_key_123';
    const missingHeader = await fetch(`http://localhost:${testPort}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'read_file', args: { path: 'package.json' } }),
    });
    expect(missingHeader.status).toBe(401);
  });

  it('refuses non-loopback binding without an API key', () => {
    const prevHost = process.env.API_BIND_HOST;
    const prevKey = process.env.OPENCATZ_API_KEY;
    try {
      process.env.API_BIND_HOST = '0.0.0.0';
      delete process.env.OPENCATZ_API_KEY;
      delete process.env.OPENCAT_API_KEY;
      expect(() => new OpenCatzRESTServer(testPort)).toThrow(/non-loopback/i);
    } finally {
      if (prevHost === undefined) delete process.env.API_BIND_HOST; else process.env.API_BIND_HOST = prevHost;
      if (prevKey === undefined) delete process.env.OPENCATZ_API_KEY; else process.env.OPENCATZ_API_KEY = prevKey;
    }
  });

  it('allows non-loopback binding when a key is configured', () => {
    const prevHost = process.env.API_BIND_HOST;
    const prevKey = process.env.OPENCATZ_API_KEY;
    let srv: OpenCatzRESTServer | null = null;
    try {
      process.env.API_BIND_HOST = '0.0.0.0';
      process.env.OPENCATZ_API_KEY = 'bound_key_xyz';
      srv = new OpenCatzRESTServer(testPort);
      expect(srv).toBeInstanceOf(OpenCatzRESTServer);
    } finally {
      void srv?.stop();
      if (prevHost === undefined) delete process.env.API_BIND_HOST; else process.env.API_BIND_HOST = prevHost;
      if (prevKey === undefined) delete process.env.OPENCATZ_API_KEY; else process.env.OPENCATZ_API_KEY = prevKey;
    }
  });

  it('enforces the CORS origin allowlist when configured', async () => {
    const prevOrigins = process.env.API_ALLOWED_ORIGINS;
    process.env.API_ALLOWED_ORIGINS = 'https://dashboard.example.com';
    const ok = await fetch(`http://localhost:${testPort}/api/status`, {
      headers: { Origin: 'https://dashboard.example.com' },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://dashboard.example.com');
    const denied = await fetch(`http://localhost:${testPort}/api/status`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(denied.status).toBe(403);
    if (prevOrigins === undefined) delete process.env.API_ALLOWED_ORIGINS; else process.env.API_ALLOWED_ORIGINS = prevOrigins;
  });

  it('rejects an oversized request body', async () => {
    const big = { command: 'x', args: { data: 'A'.repeat(2 * 1024 * 1024) } };
    const res = await fetch(`http://localhost:${testPort}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(big),
    });
    // With no key configured, /api/command is 401 before the body is read — so
    // guard the oversized-body behavior via the authenticated path.
    process.env.OPENCATZ_API_KEY = 'secret_key_123';
    // The server caps the body at 1MB and forcibly closes the connection (a
    // DoS guard — it never buffers the whole oversized payload into memory),
    // so the authenticated oversized request either fails with a network
    // reset or returns a 4xx/5xx. Assert rejection happens either way.
    let status: number | undefined;
    let reset = false;
    try {
      const authed = await fetch(`http://localhost:${testPort}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-OpenCatz-Api-Key': 'secret_key_123' },
        body: JSON.stringify(big),
      });
      status = authed.status;
    } catch {
      reset = true;
    }
    expect(res.status).toBe(401);
    expect(reset || (status !== undefined && status >= 400)).toBe(true);
    delete process.env.OPENCATZ_API_KEY;
  });

  it('does not leak internal error messages to the client', async () => {
    process.env.OPENCATZ_API_KEY = 'secret_key_123';
    // Send invalid JSON on an authenticated path — parse error must be generic.
    const res = await fetch(`http://localhost:${testPort}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OpenCatz-Api-Key': 'secret_key_123' },
      body: '{ this is not json',
    });
    const data = (await res.json()) as { error?: string };
    expect(res.status).toBe(500);
    expect(data.error).toBe('Internal server error');
    expect(data.error).not.toMatch(/Invalid JS|path|stack/i);
    delete process.env.OPENCATZ_API_KEY;
  });
});
