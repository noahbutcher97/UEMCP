export function clientDecision(context, name) {
  return context?.request?.client_decisions?.[name] === true;
}

export function approvedOwnedReplacement(context, ownership) {
  return clientDecision(context, 'replace_owned_fields')
    && ownership?.state === 'owned_user_modified';
}
