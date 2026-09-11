// client-decisions.mjs — reads per-client opt-in decisions from an apply context.
// Why: destructive write paths (replacing a user-modified owned field,
// migrating a legacy Claude project entry) require an explicit opt-in on the
// plan request rather than happening implicitly; this is the one place that
// reads that flag.
// Depends on: nothing — reads plain fields off the caller-supplied context.
export function clientDecision(context, name) {
  return context?.request?.client_decisions?.[name] === true;
}

export function approvedOwnedReplacement(context, ownership) {
  return clientDecision(context, 'replace_owned_fields')
    && ownership?.state === 'owned_user_modified';
}
