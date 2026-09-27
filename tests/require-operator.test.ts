import { describe, it, expect, afterEach } from 'vitest';
import { isOperator, baseUrlAllowed } from '../src/discord/require-operator.js';

const OLD_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...OLD_ENV };
});

const mkInteraction = (over: Partial<{
  member: { roles?: { cache?: { has: (id: string) => boolean } }; permissions?: { has: (p: string) => boolean } };
  user: { id: string };
  guild: { ownerId?: string };
}> = {}) => ({
  member: { roles: { cache: { has: () => false } }, permissions: { has: () => false } },
  user: { id: 'user-1' },
  guild: { ownerId: 'owner-1' },
  ...over,
});

describe('isOperator (P2.1 RBAC)', () => {
  it('fail-closed: no allowlist → only owner or Administrator may act', () => {
    expect(isOperator(mkInteraction()).allowed).toBe(false); // normal user
    expect(isOperator(mkInteraction({ user: { id: 'owner-1' } })).allowed).toBe(true); // owner
    expect(
      isOperator(mkInteraction({ member: { roles: { cache: { has: () => false } }, permissions: { has: () => true } } })).allowed,
    ).toBe(true); // admin permission
  });

  it('allowlist role: member holding OPERATOR_ROLE_IDS role passes', () => {
    process.env.OPERATOR_ROLE_IDS = 'role-op';
    expect(
      isOperator(mkInteraction({ member: { roles: { cache: { has: (id) => id === 'role-op' } }, permissions: { has: () => false } } })).allowed,
    ).toBe(true);
    expect(
      isOperator(mkInteraction({ member: { roles: { cache: { has: () => false } }, permissions: { has: () => false } } })).allowed,
    ).toBe(false);
  });

  it('allowlist user: OPERATOR_USER_IDS passes regardless of role', () => {
    process.env.OPERATOR_USER_IDS = 'user-op';
    expect(isOperator(mkInteraction({ user: { id: 'user-op' } })).allowed).toBe(true);
    expect(isOperator(mkInteraction({ user: { id: 'someone-else' } })).allowed).toBe(false);
  });

  it('AI_BASE_URL allowlist: rejects arbitrary hosts, allows default providers', () => {
    delete process.env.AI_BASE_URL_ALLOWLIST;
    expect(baseUrlAllowed('https://api.openai.com/v1')).toBe(true);
    expect(baseUrlAllowed('https://evil.example.com/v1')).toBe(false);
    expect(baseUrlAllowed('not a url')).toBe(false);
    process.env.AI_BASE_URL_ALLOWLIST = 'myproxy.example.com';
    expect(baseUrlAllowed('https://myproxy.example.com/v1')).toBe(true);
    expect(baseUrlAllowed('https://api.openai.com/v1')).toBe(false);
  });
});
