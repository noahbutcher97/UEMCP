// Workflow bundle selection for find_tools.
//
// Bundles are additive to direct search matches: search still returns the same
// ranked tools, and bundle toolsets are unioned into the enable plan when a
// realistic workflow prompt implies companion capabilities.

const WRITE_TOKENS = new Set([
  'add',
  'author',
  'build',
  'change',
  'compile',
  'create',
  'delete',
  'duplicate',
  'edit',
  'make',
  'modify',
  'move',
  'rename',
  'save',
  'set',
  'spawn',
  'write',
  'deleted',
  'deleting',
]);

const READ_ONLY_TOKENS = new Set([
  'audit',
  'check',
  'inspect',
  'list',
  'read',
  'review',
  'search',
  'show',
  'summarize',
  'without',
]);

export const WORKFLOW_BUNDLES = [
  {
    name: 'blueprint-authoring-live',
    toolsets: ['blueprints-write', 'actors', 'input-and-pie'],
    keywords: ['blueprint', 'bp'],
    writeKeywords: ['add', 'author', 'build', 'compile', 'create', 'make', 'spawn', 'timer', 'move'],
    companionKeywords: ['actor', 'level', 'pie', 'play', 'runtime', 'spawn', 'timer', 'verify'],
  },
  {
    name: 'blueprint-static-audit',
    toolsets: ['offline'],
    keywords: ['blueprint', 'bp', 'graph', 'node', 'nodes'],
    readKeywords: ['audit', 'find', 'inspect', 'list', 'read', 'review', 'search', 'trace', 'without'],
  },
  {
    name: 'asset-lifecycle',
    toolsets: ['editor-utility', 'asset-registry', 'offline'],
    keywords: ['asset', 'assets', 'dependency', 'dependencies', 'reference', 'references', 'registry'],
    writeKeywords: ['delete', 'deleted', 'deleting', 'duplicate', 'lifecycle', 'move', 'rename'],
  },
  {
    name: 'asset-impact-analysis',
    toolsets: ['asset-registry', 'offline'],
    keywords: ['asset', 'assets', 'dependency', 'dependencies', 'reference', 'references', 'referencer', 'referencers', 'registry'],
    readKeywords: ['affected', 'analysis', 'dependency', 'dependencies', 'impact', 'reference', 'references', 'referencer', 'referencers', 'used', 'uses', 'who'],
  },
  {
    name: 'material-authoring',
    toolsets: ['materials', 'remote-control', 'visual-capture'],
    keywords: ['material', 'materials', 'instance', 'parameter', 'preview', 'thumbnail'],
    writeKeywords: ['author', 'create', 'make', 'preview', 'set'],
  },
  {
    name: 'runtime-verification',
    toolsets: ['actors', 'input-and-pie', 'visual-capture'],
    keywords: ['runtime', 'pie', 'play', 'verify', 'validate', 'screenshot', 'capture', 'moving', 'moves'],
    companionKeywords: ['actor', 'blueprint', 'level', 'spawn', 'visual'],
  },
];

function tokenize(text) {
  if (!text) return [];
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map(t => t.toLowerCase())
    .filter(Boolean);
}

function hasAny(tokens, words) {
  return words.some(w => tokens.has(w));
}

function isReadOnlyIntent(tokenSet, query) {
  if (/\b(without|do not|don't|no)\s+(edit|change|modify|write|save|create|delete|rename|duplicate|spawn|set)\b/i.test(query)) {
    return true;
  }
  const hasRead = hasAny(tokenSet, [...READ_ONLY_TOKENS]);
  const hasWrite = hasAny(tokenSet, [...WRITE_TOKENS]);
  return hasRead && !hasWrite;
}

function resultToolsets(results) {
  return new Set(results.map(r => r.toolsetName).filter(n => n && n !== 'management'));
}

function scoreBundle(bundle, tokenSet, directToolsets, readOnly, query) {
  let score = 0;
  if (hasAny(tokenSet, bundle.keywords || [])) score += 2;
  if (hasAny(tokenSet, bundle.writeKeywords || [])) score += 2;
  if (hasAny(tokenSet, bundle.readKeywords || [])) score += 2;
  if (hasAny(tokenSet, bundle.companionKeywords || [])) score += 1;
  if (bundle.toolsets.some(t => directToolsets.has(t))) score += 1;

  if (readOnly && ['blueprint-authoring-live', 'material-authoring', 'asset-lifecycle'].includes(bundle.name)) {
    score -= 4;
  }

  if (bundle.name === 'blueprint-authoring-live') {
    const hasBlueprint = hasAny(tokenSet, ['blueprint', 'bp']);
    const hasAuthoring = hasAny(tokenSet, bundle.writeKeywords);
    const hasCompanion = hasAny(tokenSet, bundle.companionKeywords);
    if (!(hasBlueprint && hasAuthoring && hasCompanion) || readOnly) return 0;
  }

  if (bundle.name === 'blueprint-static-audit') {
    const hasBlueprintRead = hasAny(tokenSet, ['blueprint', 'bp', 'graph', 'node', 'nodes']);
    if (!(hasBlueprintRead && readOnly)) return 0;
  }

  if (bundle.name === 'asset-lifecycle') {
    const hasAsset = hasAny(tokenSet, ['asset', 'assets']);
    const hasLifecycle = hasAny(tokenSet, bundle.writeKeywords);
    if (!(hasAsset && hasLifecycle) || readOnly) return 0;
  }

  if (bundle.name === 'asset-impact-analysis') {
    const hasAsset = hasAny(tokenSet, ['asset', 'assets']);
    const hasImpact = hasAny(tokenSet, bundle.readKeywords);
    const hasLifecycleWrite = hasAny(tokenSet, ['delete', 'deleted', 'deleting', 'duplicate', 'lifecycle', 'move', 'rename']);
    if (!(hasAsset && hasImpact) || hasLifecycleWrite) return 0;
  }

  if (bundle.name === 'material-authoring') {
    const hasMaterial = hasAny(tokenSet, ['material', 'materials', 'instance']);
    const hasAuthoring = hasAny(tokenSet, bundle.writeKeywords);
    if (!(hasMaterial && hasAuthoring) || readOnly) return 0;
  }

  if (bundle.name === 'runtime-verification') {
    const hasRuntime = hasAny(tokenSet, ['runtime', 'pie', 'play', 'verify', 'validate', 'screenshot', 'capture']);
    if (!hasRuntime || readOnly) return 0;
  }

  return score;
}

/**
 * Select the best workflow bundle for a query, if any.
 * @param {string} query
 * @param {{toolsetName: string}[]} [results]
 * @returns {{name: string, toolsets: string[]}|null}
 */
export function selectWorkflowBundle(query, results = []) {
  const tokens = tokenize(query);
  const tokenSet = new Set(tokens);
  const directToolsets = resultToolsets(results);
  const readOnly = isReadOnlyIntent(tokenSet, query);

  let best = null;
  let bestScore = 0;
  for (const bundle of WORKFLOW_BUNDLES) {
    const score = scoreBundle(bundle, tokenSet, directToolsets, readOnly, query);
    if (score > bestScore) {
      best = bundle;
      bestScore = score;
    }
  }

  return best ? { name: best.name, toolsets: [...best.toolsets] } : null;
}

/**
 * Build the additive find_tools enable plan: top direct-match toolsets first,
 * then selected bundle companions, de-duplicated in insertion order.
 * @param {{toolsetName: string, score: number}[]} results
 * @param {{name: string, toolsets: string[]}|null} selectedBundle
 * @param {number} [directLimit=3]
 * @returns {{toolsetNames: string[], directToolsets: string[], bundleToolsets: string[]}}
 */
export function buildFindToolsEnablePlan(results, selectedBundle, directLimit = 3) {
  const toolsetBestScore = {};
  for (const r of results) {
    if (r.toolsetName === 'management') continue;
    if (selectedBundle?.name === 'blueprint-static-audit' && r.toolsetName === 'blueprints-write') continue;
    if (selectedBundle?.name === 'asset-impact-analysis'
      && ['editor-utility', 'visual-capture'].includes(r.toolsetName)) continue;
    if (!toolsetBestScore[r.toolsetName] || r.score > toolsetBestScore[r.toolsetName]) {
      toolsetBestScore[r.toolsetName] = r.score;
    }
  }

  const directToolsets = Object.entries(toolsetBestScore)
    .sort((a, b) => b[1] - a[1])
    .slice(0, directLimit)
    .map(([name]) => name);
  const bundleToolsets = selectedBundle ? [...selectedBundle.toolsets] : [];
  const toolsetNames = [...new Set([...directToolsets, ...bundleToolsets])];

  return { toolsetNames, directToolsets, bundleToolsets };
}

/**
 * Report selected bundle pieces that did not become active.
 * @param {{name: string, toolsets: string[]}|null} selectedBundle
 * @param {{unavailable: string[], unknown?: string[]}} enableResult
 * @returns {string[]}
 */
export function unavailableBundlePieces(selectedBundle, enableResult) {
  if (!selectedBundle) return [];
  const failed = new Set([...(enableResult.unavailable || []), ...(enableResult.unknown || [])]);
  return selectedBundle.toolsets.filter(t => failed.has(t));
}
