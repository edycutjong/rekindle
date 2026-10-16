/**
 * Provider error text reaches the browser (SSE `llm_fallback`) and every stored plan's `llm_errors`, which
 * GET /api/plans/<id> returns to anyone with the link. Groq's rate-limit messages name the account
 * ("in organization `org_…`"), so account identifiers are dropped before an error is shown or stored, and again when an
 * older stored plan is read (a2a r09).
 */
export const redactAccountIds = (text: string) => text.replace(/\borg_[A-Za-z0-9]+/g, "org_…");

/** One provider error as the trace and the stored plan carry it: name, message, account ids dropped, ≤ 300 chars. */
export const providerError = (e: unknown) => redactAccountIds(e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);
