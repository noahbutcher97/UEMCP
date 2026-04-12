// ToolIndex — keyword search across all tools
//
// Features:
//   - Tokenize + simple stemming (remove -s, -ing, -ed, -tion, -ment)
//   - Alias expansion (bp → blueprint, fx → effects, etc.)
//   - Weighted scoring: name tokens > description tokens > aliases
//   - Returns ranked results with tool name, description, parent toolset

// ── Alias map ───────────────────────────────────────────────
// Default aliases — expanded at query time. Merged with the
// canonical aliases section from tools.yaml at build() time.
// tools.yaml entries always win on conflict; these are supplements.

let ALIASES = {
  bp:         ['blueprint'],
  fx:         ['effects', 'particle', 'niagara', 'emitter'],
  vfx:        ['effects', 'particle', 'niagara', 'visual'],
  sfx:        ['audio', 'sound', 'wwise'],
  mat:        ['material'],
  mats:       ['material', 'materials'],
  anim:       ['animation', 'montage', 'sequence'],
  anims:      ['animation', 'animations'],
  ge:         ['gameplay', 'effect', 'gameplayeffect'],
  ga:         ['gameplay', 'ability', 'gameplayability'],
  gas:        ['gameplay', 'ability', 'effect', 'attribute'],
  umg:        ['widget', 'umg', 'ui', 'user', 'interface'],
  ui:         ['widget', 'umg', 'user', 'interface'],
  hud:        ['widget', 'ui'],
  pie:        ['play', 'editor', 'pie'],
  rc:         ['remote', 'control'],
  rca:        ['remote', 'control', 'api'],
  csg:        ['boolean', 'geometry', 'mesh'],
  dt:         ['datatable', 'data', 'table'],
  input:      ['input', 'mapping', 'action', 'enhanced'],
  spawn:      ['spawn', 'create', 'actor'],
  comp:       ['component'],
  prop:       ['property', 'properties'],
  props:      ['property', 'properties'],
  mesh:       ['mesh', 'static', 'skeletal', 'procedural'],
  cam:        ['camera', 'viewport'],
  tags:       ['gameplay', 'tags', 'tag'],
  config:     ['config', 'ini', 'settings'],
  screenshot: ['screenshot', 'capture', 'viewport', 'image'],
  thumb:      ['thumbnail', 'preview', 'image'],
};

// ── Stemmer (minimal, English-ish) ──────────────────────────

/**
 * Very simple suffix-stripping stemmer. Good enough for tool search —
 * we're matching short technical terms, not prose.
 * @param {string} word
 * @returns {string}
 */
function stem(word) {
  if (word.length <= 3) return word;
  // Order matters — try longest suffixes first
  if (word.endsWith('ation')) return word.slice(0, -5);
  if (word.endsWith('ment')) return word.slice(0, -4);
  if (word.endsWith('ness')) return word.slice(0, -4);
  if (word.endsWith('ting')) return word.slice(0, -4) + 't'; // creating → creat
  if (word.endsWith('ing')) return word.slice(0, -3);
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('ied')) return word.slice(0, -3) + 'y';
  if (word.endsWith('es')) return word.slice(0, -2);
  if (word.endsWith('ed')) return word.slice(0, -2);
  if (word.endsWith('ly')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

// ── Tokenizer ───────────────────────────────────────────────

/**
 * Tokenize a string into stemmed terms.
 * Splits on underscores, hyphens, spaces, camelCase boundaries.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text) return [];
  return text
    // insert space before uppercase in camelCase (getBlueprint → get Blueprint)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // split on non-alphanumeric
    .split(/[^a-zA-Z0-9]+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length > 1)
    .map(stem);
}

// ── Scoring weights ─────────────────────────────────────────
// 6 tiers from dynamic-toolsets.md spec, plus alias bonus.

const WEIGHT = {
  FULL_NAME:     100,  // Tier 1: exact full tool name match
  NAME_EXACT:     10,  // Tier 2: query token matches a name token exactly
  NAME_PREFIX:     6,  // Tier 3: query token is a prefix of a name token (≥3 chars)
  NAME_SUBSTR:     4,  // Tier 4: query token is a substring of a name token (≥3 chars)
  DESC_EXACT:      2,  // Tier 5: query token matches a description token exactly
  DESC_PREFIX:     1,  // Tier 6: query token is a prefix of a description token (≥3 chars)
  ALIAS_BONUS:     2,  // tool-level alias hit
};

// ── Index entry ─────────────────────────────────────────────

/**
 * @typedef {object} IndexEntry
 * @property {string} toolName
 * @property {string} toolsetName
 * @property {string} description
 * @property {string} layer
 * @property {string[]} nameTokens   — stemmed tokens from tool name
 * @property {string[]} descTokens   — stemmed tokens from description
 * @property {string[]} [aliases]    — from tools.yaml aliases field
 */

// ── ToolIndex class ─────────────────────────────────────────

export class ToolIndex {
  constructor() {
    /** @type {IndexEntry[]} */
    this._entries = [];
  }

  /**
   * Build the index from parsed tools.yaml data.
   * Call once at startup after loading YAML.
   * @param {object} toolsData — parsed tools.yaml root object
   */
  build(toolsData) {
    this._entries = [];

    // Merge canonical aliases from tools.yaml (overrides defaults on conflict)
    if (toolsData.aliases) {
      for (const [abbrev, tokens] of Object.entries(toolsData.aliases)) {
        // YAML tokens are already arrays (e.g., [gameplay, effect])
        // Stem them to match our query pipeline
        ALIASES[abbrev] = Array.isArray(tokens)
          ? tokens.map(t => stem(t.toLowerCase()))
          : tokenize(String(tokens));
      }
    }

    // Index management tools
    if (toolsData.management?.tools) {
      for (const [name, def] of Object.entries(toolsData.management.tools)) {
        this._entries.push({
          toolName: name,
          toolsetName: 'management',
          description: def.description || '',
          layer: 'always',
          nameTokens: tokenize(name),
          descTokens: tokenize(def.description || ''),
          aliases: def.aliases || [],
        });
      }
    }

    // Index toolset tools
    if (toolsData.toolsets) {
      for (const [tsName, tsDef] of Object.entries(toolsData.toolsets)) {
        if (!tsDef.tools) continue;
        for (const [name, def] of Object.entries(tsDef.tools)) {
          this._entries.push({
            toolName: name,
            toolsetName: tsName,
            description: def.description || '',
            layer: tsDef.layer || 'unknown',
            nameTokens: tokenize(name),
            descTokens: tokenize(def.description || ''),
            aliases: def.aliases || [],
          });
        }
      }
    }
  }

  /**
   * Search for tools matching a query string.
   * @param {string} query
   * @param {number} [maxResults=15]
   * @returns {{toolName: string, toolsetName: string, description: string, layer: string, score: number}[]}
   */
  search(query, maxResults = 15) {
    // Tokenize and expand query
    let queryTokens = tokenize(query);

    // Expand aliases in query
    const expanded = new Set(queryTokens);
    for (const qt of queryTokens) {
      const aliasTargets = ALIASES[qt];
      if (aliasTargets) {
        for (const t of aliasTargets) {
          expanded.add(stem(t));
        }
      }
    }
    queryTokens = [...expanded];

    if (queryTokens.length === 0) return [];

    // Normalize query string for Tier 1 (exact full tool name match)
    const queryNormalized = query.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');

    // Score each entry
    const scored = [];
    for (const entry of this._entries) {
      let score = 0;
      let aliasHit = false;
      const matchedTokens = new Set(); // track which query tokens contributed

      // Tier 1: exact full tool name match
      if (entry.toolName === queryNormalized) {
        score += WEIGHT.FULL_NAME;
        // All original query tokens count as matched
        for (const qt of queryTokens) matchedTokens.add(qt);
      }

      for (const qt of queryTokens) {
        let tokenMatched = false;

        // Check name tokens (Tiers 2-4)
        for (const nt of entry.nameTokens) {
          if (nt === qt) {
            score += WEIGHT.NAME_EXACT;       // Tier 2
            tokenMatched = true;
          } else if (qt.length >= 3 && nt.startsWith(qt)) {
            score += WEIGHT.NAME_PREFIX;      // Tier 3
            tokenMatched = true;
          } else if (qt.length >= 3 && nt.includes(qt)) {
            score += WEIGHT.NAME_SUBSTR;      // Tier 4
            tokenMatched = true;
          }
        }

        // Check description tokens (Tiers 5-6)
        for (const dt of entry.descTokens) {
          if (dt === qt) {
            score += WEIGHT.DESC_EXACT;       // Tier 5
            tokenMatched = true;
          } else if (qt.length >= 3 && dt.startsWith(qt)) {
            score += WEIGHT.DESC_PREFIX;      // Tier 6
            tokenMatched = true;
          }
        }

        // Check tool-level aliases
        for (const alias of entry.aliases) {
          const aliasTokens = tokenize(alias);
          for (const at of aliasTokens) {
            if (at === qt || (qt.length >= 3 && at.startsWith(qt))) {
              aliasHit = true;
              tokenMatched = true;
            }
          }
        }

        if (tokenMatched) matchedTokens.add(qt);
      }

      if (aliasHit) score += WEIGHT.ALIAS_BONUS;

      if (score > 0) {
        // Coverage bonus: reward tools matching ALL query terms.
        // Formula: score × (0.5 + 0.5 × matched_ratio)
        // Single-token queries: ratio=1.0 → multiplier=1.0 (no change)
        // Multi-token queries: 1-of-3 matched → 0.667, 3-of-3 → 1.0
        const matchedRatio = matchedTokens.size / queryTokens.length;
        score = score * (0.5 + 0.5 * matchedRatio);

        scored.push({
          toolName: entry.toolName,
          toolsetName: entry.toolsetName,
          description: entry.description,
          layer: entry.layer,
          score: Math.round(score * 100) / 100, // clean up floating point
        });
      }
    }

    // Sort by score descending, then by name alphabetically
    scored.sort((a, b) => b.score - a.score || a.toolName.localeCompare(b.toolName));

    return scored.slice(0, maxResults);
  }

  /**
   * Get all tools in a specific toolset.
   * @param {string} toolsetName
   * @returns {{toolName: string, description: string, layer: string}[]}
   */
  getToolsetTools(toolsetName) {
    return this._entries
      .filter(e => e.toolsetName === toolsetName)
      .map(({ toolName, description, layer }) => ({ toolName, description, layer }));
  }

  /**
   * Get list of all toolset names (excluding 'management').
   * @returns {string[]}
   */
  getToolsetNames() {
    const names = new Set();
    for (const e of this._entries) {
      if (e.toolsetName !== 'management') {
        names.add(e.toolsetName);
      }
    }
    return [...names];
  }

  /**
   * Total tool count.
   * @returns {number}
   */
  get size() {
    return this._entries.length;
  }
}
