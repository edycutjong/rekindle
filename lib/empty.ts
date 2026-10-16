/**
 * Empty-slot reasons double as state: an outage may be routed again and never offers a wider radius; a tool failure is
 * not a coverage refusal. Producers start their sentence with one of these prefixes and every reader matches the
 * prefix, never its own copy of the literal (a2a r09: five modules each held one, so re-wording a producer would have
 * silently turned an outage into a coverage refusal). The text is unchanged: stored plans keep their strings.
 */
export const EMPTY = { outage: "Qloo unavailable", toolFailed: "tool failed", notRouted: "not routed" } as const;

export const isOutageReason = (reason: string | null | undefined) => !!reason && reason.startsWith(EMPTY.outage);
export const isToolFailureReason = (reason: string | null | undefined) => !!reason && (reason.startsWith(EMPTY.toolFailed) || reason.startsWith(EMPTY.notRouted));
