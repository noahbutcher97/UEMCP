// client-ids.mjs — the canonical client ID list.
// Why: ['claude', 'codex', 'gemini', 'vscode'] is the closed set every other
// module (contracts, adapters, discovery, the ownership ledger) validates
// client IDs against; it lives in its own file so client-contract and
// ownership-ledger can both import it without a circular dependency.
// Depends on: nothing.
export const CLIENT_IDS = Object.freeze(['claude', 'codex', 'gemini', 'vscode']);
