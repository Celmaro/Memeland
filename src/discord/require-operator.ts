/**
 * P2.1 — Discord RBAC (security-audit fix #1).
 *
 * The control room limits interactions to the right CHANNEL, but being in the
 * right channel is not authorization. Every sensitive action (APPROVE/CANCEL,
 * send/swap, set-risk, start/pause agents, emergency-stop, set-api-key,
 * switch-ai-model) must pass an explicit operator check in CODE — never rely on
 * Discord server settings alone (least privilege).
 *
 * Operator = any member whose role id is in OPERATOR_ROLE_IDS, or whose user id
 * is in OPERATOR_USER_IDS (comma-separated env). Fail-closed: no allowlist
 * configured => only the guild owner may act.
 */

export interface OperatorCheck {
  allowed: boolean;
  reason?: string;
}

/** Allowed role ids (env OPERATOR_ROLE_IDS, comma-separated Discord snowflakes). */
export function operatorRoleIds(): Set<string> {
  return new Set((process.env.OPERATOR_ROLE_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

/** Allowed user ids (env OPERATOR_USER_IDS, comma-separated Discord snowflakes). */
export function operatorUserIds(): Set<string> {
  return new Set((process.env.OPERATOR_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

/** True when any operator allowlist is configured. */
export function operatorConfigured(): boolean {
  return operatorRoleIds().size > 0 || operatorUserIds().size > 0;
}

/**
 * Check a Discord interaction's actor against the operator allowlists.
 * Fail-closed: without any allowlist configured, only a member with
 * Administrator permission may act; otherwise the actor must hold an
 * allowlisted role or be an allowlisted user.
 *
 * `member` is nullable (interactions outside a guild); null → denied.
 */
export function isOperator(interaction: {
  member?: {
    roles?: { cache?: { has(id: string): boolean } } | string[] | null;
    permissions?: { has(p: unknown): boolean } | string | null;
  } | null;
  user?: { id: string };
  guildId?: string | null;
  guild?: { ownerId?: string } | null;
}): OperatorCheck {
  const member = interaction.member;
  const userId = interaction.user?.id;
  if (!member || !userId) return { allowed: false, reason: 'no member context' };
  const rolesCache = member.roles && !Array.isArray(member.roles) ? member.roles.cache : undefined;
  const canAdmin = typeof member.permissions === 'object' && member.permissions !== null
    ? member.permissions.has('Administrator')
    : false;

  // Explicit allowlist configured → role or user id must match.
  const roles = operatorRoleIds();
  const users = operatorUserIds();
  if (roles.size > 0 || users.size > 0) {
    if (users.has(userId)) return { allowed: true };
    if (roles.size > 0 && rolesCache) {
      for (const r of roles) {
        if (rolesCache.has(r)) return { allowed: true };
      }
    }
    return { allowed: false, reason: 'actor not in operator allowlist' };
  }

  // No allowlist → fail closed: only guild owner or Administrator.
  const isOwner = interaction.guild?.ownerId === userId;
  if (isOwner) return { allowed: true };
  if (canAdmin) return { allowed: true };
  return { allowed: false, reason: 'no operator allowlist configured and actor is not owner/admin' };
}

/** Convenience: throw-style gate for handlers that can early-return. */
export function requireOperator(interaction: Parameters<typeof isOperator>[0]): OperatorCheck {
  return isOperator(interaction);
}

/**
 * P2.1 / security-audit #6 — AI_BASE_URL allowlist.
 * switch_ai_model can redirect the LLM endpoint; only permit known-good hosts.
 * Env AI_BASE_URL_ALLOWLIST = comma-separated hostnames; empty => only the
 * default provider host (api.openai.com etc.) is permitted.
 */
export function baseUrlAllowed(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const allow = (process.env.AI_BASE_URL_ALLOWLIST ?? '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (allow.length === 0) {
      // Default allow: the documented provider hosts.
      return ['api.openai.com', 'api.anthropic.com', 'openrouter.ai', 'api.deepseek.com', 'generativelanguage.googleapis.com', 'api.groq.com'].includes(host);
    }
    return allow.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}
