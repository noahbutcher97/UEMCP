// ToolIndex — keyword search across all tools
//
// Features:
//   - Tokenize + simple stemming (remove -s, -ing, -ed, -tion, -ment)
//   - Alias expansion (bp → blueprint, fx → effects, etc.)
//   - Weighted scoring: name tokens > description tokens > aliases
//   - Returns ranked results with tool name, description, parent toolset

// ── Alias map ───────────────────────────────────────────────
// Expand common abbreviations to canonical terms.
// Both the alias and expansion get indexed, so "bp" matches
// tools with "blueprint" in their name/description.

const ALIASES = {
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

const WEIGHT = {
  NAME_EXACT:  10,   // query token matches a name token exactly
  NAME_PREFIX:  6,   // query token is a prefix of a name token
  DESC_EXACT:   3,   // query token matches a description token
  DESC_PREFIX:  1.5, // query token is a prefix of a description token
  ALIAS_BONUS:  2,   // alias expansion contributed a match
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

    // Score each entry
    const scored = [];
    for (const entry of this._entries) {
      let score = 0;
      let aliasHit = false;

      for (const qt of queryTokens) {
        // Check name tokens
        for (const nt of entry.nameTokens) {
          if (nt === qt) {
            score += WEIGHT.NAME_EXACT;
          } else if (nt.startsWith(qt) || qt.startsWith(nt)) {
            score += WEIGHT.NAME_PREFIX;
          }
        }

        // Check description tokens
        for (const dt of entry.descTokens) {
          if (dt === qt) {
            score += WEIGHT.DESC_EXACT;
          } else if (dt.startsWith(qt) || qt.startsWith(dt)) {
            score += WEIGHT.DESC_PREFIX;
          }
        }

        // Check tool-level aliases (e.g., get_all_blueprint_graphs → get_blueprint_graphs)
        for (const alias of entry.aliases) {
          const aliasTokens = tokenize(alias);
          for (const at of aliasTokens) {
            if (at === qt || at.startsWith(qt)) {
              aliasHit = true;
            }
          }
        }
      }

      if (aliasHit) score += WEIGHT.ALIAS_BONUS;

      if (score > 0) {
        scored.push({
          toolName: entry.toolName,
          toolsetName: entry.toolsetName,
          description: entry.description,
          layer: entry.layer,
          score,
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
