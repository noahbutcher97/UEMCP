// Session-local Unreal project attachment state.

import { basename, dirname, extname } from 'node:path';
import { PROJECT_ERROR_CODES, ProjectContextError, makeProjectError, makeProjectToolResult } from './project-errors.mjs';
import { createProjectIdentity, normalizeComparisonPath, scanWorkspaceRoot } from './project-identity.mjs';
import { readProjectTargets } from './project-targets.mjs';
import { TOOL_REQUIREMENT_KINDS } from './tool-requirements.mjs';

const ATTACH_MODES = new Set(['workspace', 'env']);

function warning(code, message, details = {}) {
  return { code, message, ...details };
}

function canonicalOf(identity) {
  return identity?.canonicalUprojectPath || '';
}

function normalizeDeployState(diagnostic = {}) {
  const explicitState = (diagnostic.state || diagnostic.deployFreshnessState || '').toLowerCase();
  if (explicitState) return explicitState;

  const verdict = (diagnostic.verdict || diagnostic.status || '').toString().toLowerCase();
  if (diagnostic.code === PROJECT_ERROR_CODES.DEPLOY_STALE || ['stale', 'fail', 'failed', 'mismatch'].includes(verdict)) {
    return 'stale';
  }
  if (diagnostic.ok === true || ['fresh', 'sync', 'synced', 'pass', 'passed', 'ok'].includes(verdict)) {
    return 'fresh';
  }
  return 'not_checked';
}

function truthyInputCount(input, keys) {
  return keys.reduce((count, key) => (input[key] ? count + 1 : count), 0);
}

function editorCandidateFromProcess(editorProcess, fsImpl, clientRoots) {
  const candidate = {
    pid: editorProcess.pid,
    cmdLine: editorProcess.cmdLine || '',
    commandLineAvailable: editorProcess.commandLineAvailable === true,
    uprojectPath: editorProcess.uprojectPath || null,
  };
  if (!candidate.uprojectPath) return candidate;

  try {
    const identity = createProjectIdentity({
      uprojectPath: candidate.uprojectPath,
      source: 'running_editor',
      fsImpl,
      clientRoots,
    });
    return { ...candidate, ...identity };
  } catch (err) {
    const projectRoot = dirname(candidate.uprojectPath);
    return {
      ...candidate,
      projectRoot,
      canonicalProjectRoot: normalizeComparisonPath(projectRoot),
      canonicalUprojectPath: normalizeComparisonPath(candidate.uprojectPath),
      projectName: basename(candidate.uprojectPath, extname(candidate.uprojectPath)),
      warnings: [{
        code: err.code || PROJECT_ERROR_CODES.PROJECT_PATH_INVALID,
        message: err.message,
      }],
    };
  }
}

function unwrapEditorStatePayload(payload) {
  if (payload?.result && typeof payload.result === 'object') return payload.result;
  return payload || {};
}

export class ProjectContext {
  constructor({
    cwd,
    repoRoot,
    env = {},
    workspaceRoots = [],
    fsImpl,
    sdkServer = null,
    processInspector = null,
    deployInspector = null,
  } = {}) {
    this.cwd = cwd || process.cwd();
    this.repoRoot = repoRoot || this.cwd;
    this.env = env;
    this.fsImpl = fsImpl;
    this.sdkServer = sdkServer;
    this.processInspector = processInspector;
    this.deployInspector = deployInspector;

    this.warnings = [];
    this.attachmentState = 'unresolved';
    this.attachMode = this._parseAttachMode(env.UEMCP_PROJECT_ATTACH_MODE);
    this.generation = 0;
    this.identity = null;
    this.workspaceRoots = [...workspaceRoots];
    this.candidates = [];
    this.legacyEnvCandidate = null;
    this.lastResolvedAt = null;
    this.editorIdentityState = 'not_checked';
    this.editorCandidates = [];
    this.transportOwnershipState = 'not_checked';
    this.deployFreshnessState = 'not_checked';
    this.deployFreshness = { state: 'not_checked' };
    this._resetHandlers = [];
    this._inFlightMutations = new Map();
    this._nextMutationId = 1;
  }

  _parseAttachMode(value) {
    const mode = (value || 'workspace').trim();
    if (ATTACH_MODES.has(mode)) return mode;
    this.warnings.push(warning(
      PROJECT_ERROR_CODES.PROJECT_ATTACH_MODE_INVALID,
      `Invalid UEMCP_PROJECT_ATTACH_MODE "${mode}", falling back to workspace.`,
      { value: mode },
    ));
    return 'workspace';
  }

  onReset(handler) {
    this._resetHandlers.push(handler);
  }

  snapshot() {
    return {
      attachmentState: this.attachmentState,
      attachMode: this.attachMode,
      generation: this.generation,
      identity: this.identity,
      workspaceRoots: [...this.workspaceRoots],
      candidates: [...this.candidates],
      legacyEnvCandidate: this.legacyEnvCandidate,
      warnings: [...this.warnings],
      lastResolvedAt: this.lastResolvedAt,
      editorIdentityState: this.editorIdentityState,
      editorCandidates: [...this.editorCandidates],
      transportOwnershipState: this.transportOwnershipState,
      deployFreshnessState: this.deployFreshnessState,
      deployFreshness: { ...this.deployFreshness },
      inFlightMutations: this.getInFlightMutationCount(),
    };
  }

  beginMutation(metadata = {}) {
    const id = this._nextMutationId++;
    this._inFlightMutations.set(id, {
      id,
      startedAt: new Date().toISOString(),
      ...metadata,
    });
    return id;
  }

  endMutation(id) {
    this._inFlightMutations.delete(id);
  }

  getInFlightMutationCount() {
    return this._inFlightMutations.size;
  }

  evaluateToolReadiness(options = {}) {
    const requirement = options.requirement || TOOL_REQUIREMENT_KINDS.OFFLINE_READ;
    if (requirement === TOOL_REQUIREMENT_KINDS.MANAGEMENT) {
      return { ok: true, identity: this.identity };
    }

    if (!this.identity) {
      return {
        ok: false,
        error: makeProjectError(
          PROJECT_ERROR_CODES.PROJECT_NOT_ATTACHED,
          'No Unreal project is attached for this UEMCP session.',
          {
            attachmentState: this.attachmentState,
            workspaceRoots: [...this.workspaceRoots],
            candidates: [...this.candidates],
            next: { tool: 'attach_project' },
          },
        ),
      };
    }

    if (requirement === TOOL_REQUIREMENT_KINDS.OFFLINE_READ) {
      return { ok: true, identity: this.identity };
    }

    if (this.editorIdentityState !== 'verified') {
      return {
        ok: false,
        error: makeProjectError(
          PROJECT_ERROR_CODES.EDITOR_IDENTITY_UNKNOWN,
          'Editor project identity has not been verified for the attached project.',
          {
            editorIdentityState: this.editorIdentityState,
            projectContext: this.snapshot(),
          },
        ),
      };
    }

    if (
      requirement === TOOL_REQUIREMENT_KINDS.LIVE_MUTATION ||
      requirement === TOOL_REQUIREMENT_KINDS.RC_MUTATION ||
      requirement === TOOL_REQUIREMENT_KINDS.PYTHON_EXEC
    ) {
      if (this.transportOwnershipState !== 'verified') {
        return {
          ok: false,
          error: makeProjectError(
            PROJECT_ERROR_CODES.TRANSPORT_OWNER_UNKNOWN,
            'UEMCP transport ownership has not been verified for live mutation.',
            {
              transportOwnershipState: this.transportOwnershipState,
              projectContext: this.snapshot(),
            },
          ),
        };
      }

      if (this.deployFreshnessState === 'stale') {
        return {
          ok: false,
          error: makeProjectError(
            PROJECT_ERROR_CODES.DEPLOY_STALE,
            this.deployFreshness.message || 'Plugin deployment is stale for the attached project.',
            {
              deploy: { ...this.deployFreshness },
              projectContext: this.snapshot(),
            },
          ),
        };
      }
    }

    return { ok: true, identity: this.identity };
  }

  setDeployReadiness(diagnostic = {}) {
    const state = normalizeDeployState(diagnostic);
    this.deployFreshnessState = state;
    this.deployFreshness = {
      ...diagnostic,
      state,
    };
    return { ...this.deployFreshness };
  }

  refreshEditorProcesses(editorProcesses = []) {
    this.editorCandidates = editorProcesses.map(editorProcess =>
      editorCandidateFromProcess(editorProcess, this.fsImpl, this.workspaceRoots)
    );

    const candidates = [...this.editorCandidates];
    const known = candidates.filter(candidate => candidate.canonicalUprojectPath);
    const unknown = candidates.filter(candidate => !candidate.canonicalUprojectPath);

    if (candidates.length === 0) {
      this.editorIdentityState = 'unavailable';
      return {
        state: this.editorIdentityState,
        code: PROJECT_ERROR_CODES.EDITOR_UNAVAILABLE,
        message: 'No Unreal Editor process is visible.',
        candidates,
      };
    }

    if (!this.identity) {
      if (known.length === 0 && unknown.length > 0) {
        this.editorIdentityState = 'unknown';
        return {
          state: this.editorIdentityState,
          code: PROJECT_ERROR_CODES.EDITOR_IDENTITY_UNKNOWN,
          message: 'Unreal Editor is running, but its project command line is unavailable.',
          candidates,
        };
      }
      this.editorIdentityState = known.length > 1 ? 'ambiguous' : 'candidate';
      return {
        state: this.editorIdentityState,
        candidates,
      };
    }

    const target = this.identity.canonicalUprojectPath;
    const matches = known.filter(candidate => candidate.canonicalUprojectPath === target);
    if (matches.length > 0) {
      this.editorIdentityState = 'verified';
      return {
        state: this.editorIdentityState,
        candidates,
        matchedEditor: matches[0],
      };
    }

    if (known.length > 0) {
      this.editorIdentityState = 'mismatch';
      return {
        state: this.editorIdentityState,
        code: PROJECT_ERROR_CODES.EDITOR_PROJECT_MISMATCH,
        message: 'Visible Unreal Editor processes do not match the attached project.',
        candidates,
        attachedProject: this.identity,
      };
    }

    this.editorIdentityState = 'unknown';
    return {
      state: this.editorIdentityState,
      code: PROJECT_ERROR_CODES.EDITOR_IDENTITY_UNKNOWN,
      message: 'Unreal Editor is running, but its project command line is unavailable.',
      candidates,
    };
  }

  refreshEditorHandshake(payload = {}) {
    const editorState = unwrapEditorStatePayload(payload);
    const identitySource = editorState.project_identity || editorState.projectIdentity || editorState;
    const uprojectPath =
      identitySource.uproject_path ||
      identitySource.uprojectPath ||
      identitySource.project_file ||
      identitySource.projectFile ||
      '';

    if (!uprojectPath) {
      this.transportOwnershipState = 'unverified';
      return {
        source: 'plugin_handshake',
        state: 'unknown',
        code: PROJECT_ERROR_CODES.EDITOR_IDENTITY_UNKNOWN,
        message: 'Plugin get_editor_state did not include project identity.',
        raw: editorState,
      };
    }

    const candidate = editorCandidateFromProcess({
      pid: null,
      cmdLine: 'plugin:get_editor_state',
      commandLineAvailable: true,
      uprojectPath,
    }, this.fsImpl, this.workspaceRoots);

    if (identitySource.project_root || identitySource.projectRoot) {
      candidate.projectRoot = identitySource.project_root || identitySource.projectRoot;
      candidate.canonicalProjectRoot = normalizeComparisonPath(candidate.projectRoot);
    }
    if (identitySource.project_name || identitySource.projectName) {
      candidate.projectName = identitySource.project_name || identitySource.projectName;
    }
    candidate.plugin = {
      version: editorState.plugin_version ?? editorState.pluginVersion ?? null,
      versionName: editorState.plugin_version_name ?? editorState.pluginVersionName ?? null,
    };
    candidate.deployMarker = {
      present: editorState.deploy_marker_present ?? editorState.deployMarkerPresent ?? null,
      schemaVersion: editorState.deploy_marker_schema_version ?? editorState.deployMarkerSchemaVersion ?? null,
      manifestVersion: editorState.deploy_marker_manifest_version ?? editorState.deployMarkerManifestVersion ?? null,
      upluginVersion: editorState.deploy_marker_uplugin_version ?? editorState.deployMarkerUpluginVersion ?? null,
    };

    this.editorCandidates = [candidate];

    if (!this.identity) {
      this.editorIdentityState = 'candidate';
      this.transportOwnershipState = 'unverified';
      return {
        source: 'plugin_handshake',
        state: this.editorIdentityState,
        candidates: [...this.editorCandidates],
      };
    }

    if (candidate.canonicalUprojectPath === this.identity.canonicalUprojectPath) {
      this.editorIdentityState = 'verified';
      this.transportOwnershipState = 'verified';
      return {
        source: 'plugin_handshake',
        state: this.editorIdentityState,
        matchedEditor: candidate,
        candidates: [...this.editorCandidates],
      };
    }

    this.editorIdentityState = 'mismatch';
    this.transportOwnershipState = 'unverified';
    return {
      source: 'plugin_handshake',
      state: this.editorIdentityState,
      code: PROJECT_ERROR_CODES.EDITOR_PROJECT_MISMATCH,
      message: 'Plugin get_editor_state identity does not match the attached project.',
      candidates: [...this.editorCandidates],
      attachedProject: this.identity,
    };
  }

  async initializeFromProcessHints({ workspaceRoots } = {}) {
    if (workspaceRoots) this.workspaceRoots = [...workspaceRoots];
    this._refreshLegacyEnvCandidate();

    if (this.attachMode === 'env' && this.legacyEnvCandidate) {
      await this._transition({
        attachmentState: 'attached',
        identity: this.legacyEnvCandidate,
        candidates: [this.legacyEnvCandidate],
      }, 'env_mode_attach');
      return this.snapshot();
    }

    const resolved = this._resolveWorkspace();
    if (resolved.identity) {
      this._recordLegacyEnvConflict(resolved.identity);
      await this._transition({
        attachmentState: 'auto_attached',
        identity: resolved.identity,
        candidates: resolved.candidates,
      }, 'workspace_auto_attach');
    } else {
      this.attachmentState = 'unresolved';
      this.identity = null;
      this.candidates = resolved.candidates;
      this.lastResolvedAt = new Date().toISOString();
    }
    return this.snapshot();
  }

  async refreshFromClientRoots({ roots = this.workspaceRoots, reason = 'roots_refresh' } = {}) {
    this.workspaceRoots = [...roots];
    const resolved = this._resolveWorkspace();
    if (resolved.identity) {
      await this._transition({
        attachmentState: 'auto_attached',
        identity: resolved.identity,
        candidates: resolved.candidates,
      }, reason);
    } else {
      await this._transition({
        attachmentState: 'unresolved',
        identity: null,
        candidates: resolved.candidates,
      }, reason);
    }
    return this.snapshot();
  }

  async refreshProjectContext(options = {}) {
    return this.refreshFromClientRoots({ reason: options.reason || 'refresh_project_context' });
  }

  async attachProject(input = {}) {
    this._assertNoInFlightMutation(input.force_generation_change === true);
    const sourceKeys = ['project_root', 'uproject_path', 'target', 'from_running_editor'];
    const count = truthyInputCount(input, sourceKeys);
    if (count !== 1) {
      throw new ProjectContextError(
        count > 1 ? PROJECT_ERROR_CODES.PROJECT_AMBIGUOUS : PROJECT_ERROR_CODES.PROJECT_PATH_INVALID,
        'attach_project requires exactly one project source.',
        { sources: sourceKeys.filter(key => input[key]) },
      );
    }

    const identity = this._identityFromAttachInput(input);
    if (identity.outsideClientRoot && !input.allow_outside_client_roots) {
      throw new ProjectContextError(
        PROJECT_ERROR_CODES.PROJECT_OUTSIDE_CLIENT_ROOT,
        'Project is outside the MCP client roots.',
        { projectRoot: identity.projectRoot, workspaceRoots: this.workspaceRoots },
      );
    }

    if (identity.outsideClientRoot && input.allow_outside_client_roots) {
      this.warnings.push(warning(
        PROJECT_ERROR_CODES.PROJECT_OUTSIDE_CLIENT_ROOT,
        'Attached project is outside the MCP client roots by explicit override.',
        { projectRoot: identity.projectRoot },
      ));
    }

    await this._transition({
      attachmentState: 'attached',
      identity,
      candidates: [identity],
    }, 'manual_attach');
    return this.snapshot();
  }

  async detachProject(input = {}) {
    this._assertNoInFlightMutation(input.force_generation_change === true);
    const resolved = this._resolveWorkspace();
    await this._transition({
      attachmentState: resolved.identity ? 'auto_attached' : 'unresolved',
      identity: resolved.identity,
      candidates: resolved.candidates,
    }, 'detach_project');
    return this.snapshot();
  }

  _assertNoInFlightMutation(force) {
    if (this.getInFlightMutationCount() === 0) return;
    if (force) {
      this.warnings.push(warning(
        PROJECT_ERROR_CODES.IN_FLIGHT_MUTATION_BLOCKED,
        'Project context changed while live mutations were in flight by explicit force.',
        { inFlightMutations: this.getInFlightMutationCount() },
      ));
      return;
    }
    throw new ProjectContextError(
      PROJECT_ERROR_CODES.IN_FLIGHT_MUTATION_BLOCKED,
      'Project context cannot change while live mutations are in flight.',
      { inFlightMutations: this.getInFlightMutationCount() },
    );
  }

  _identityFromAttachInput(input) {
    if (input.project_root) {
      return createProjectIdentity({
        projectRoot: input.project_root,
        source: 'attach_project',
        fsImpl: this.fsImpl,
        clientRoots: this.workspaceRoots,
      });
    }
    if (input.uproject_path) {
      return createProjectIdentity({
        uprojectPath: input.uproject_path,
        source: 'attach_project',
        fsImpl: this.fsImpl,
        clientRoots: this.workspaceRoots,
      });
    }
    if (input.from_running_editor) {
      return createProjectIdentity({
        uprojectPath: input.from_running_editor,
        source: 'running_editor',
        fsImpl: this.fsImpl,
        clientRoots: this.workspaceRoots,
      });
    }
    return this._identityFromTarget(input.target);
  }

  _identityFromTarget(target) {
    const targets = readProjectTargets({
      repoRoot: this.repoRoot,
      fsImpl: this.fsImpl,
      clientRoots: this.workspaceRoots,
    });

    if (targets.aliasCollisions.some(c => c.alias === target)) {
      throw new ProjectContextError(
        PROJECT_ERROR_CODES.TARGET_ALIAS_AMBIGUOUS,
        `Target alias "${target}" is ambiguous.`,
        { target, collisions: targets.aliasCollisions.filter(c => c.alias === target) },
      );
    }

    const canonical = targets.aliases[target];
    if (!canonical) {
      throw new ProjectContextError(
        PROJECT_ERROR_CODES.PROJECT_PATH_INVALID,
        `Unknown project target: ${target}`,
        { target, status: targets.status },
      );
    }

    const identity = targets.candidates.find(c => c.canonicalUprojectPath === canonical);
    if (!identity) {
      throw new ProjectContextError(
        PROJECT_ERROR_CODES.PROJECT_PATH_INVALID,
        `Project target did not resolve to a candidate: ${target}`,
        { target },
      );
    }
    return identity;
  }

  _refreshLegacyEnvCandidate() {
    const root = (this.env.UNREAL_PROJECT_ROOT || '').trim();
    if (!root) {
      this.legacyEnvCandidate = null;
      return;
    }
    try {
      this.legacyEnvCandidate = createProjectIdentity({
        projectRoot: root,
        source: 'legacy-env',
        fsImpl: this.fsImpl,
        clientRoots: this.workspaceRoots,
      });
    } catch (err) {
      this.legacyEnvCandidate = null;
      this.warnings.push(warning(
        err.code || PROJECT_ERROR_CODES.PROJECT_PATH_INVALID,
        `Legacy UNREAL_PROJECT_ROOT is invalid: ${err.message}`,
        { projectRoot: root },
      ));
    }
  }

  _recordLegacyEnvConflict(identity) {
    if (!this.legacyEnvCandidate) return;
    if (canonicalOf(this.legacyEnvCandidate) === canonicalOf(identity)) return;
    this.warnings.push(warning(
      'LEGACY_ENV_CONFLICT',
      'Workspace project differs from legacy UNREAL_PROJECT_ROOT.',
      {
        workspaceProject: identity.uprojectPath,
        legacyEnvProject: this.legacyEnvCandidate.uprojectPath,
      },
    ));
  }

  _workspaceRootsForResolution() {
    return this.workspaceRoots.length > 0 ? this.workspaceRoots : [this.cwd];
  }

  _resolveWorkspace() {
    const roots = this._workspaceRootsForResolution();
    const allCandidates = [];
    const resolvedCandidates = [];

    for (const root of roots) {
      const result = scanWorkspaceRoot(root, {
        fsImpl: this.fsImpl,
        clientRoots: roots,
      });
      allCandidates.push(...result.candidates);
      if (result.status === 'resolved' && result.candidates.length === 1) {
        resolvedCandidates.push(result.candidates[0]);
      }
    }

    if (resolvedCandidates.length === 1) {
      return { identity: resolvedCandidates[0], candidates: allCandidates };
    }
    return { identity: null, candidates: allCandidates };
  }

  async _transition({ attachmentState, identity, candidates }, reason) {
    const previousIdentity = this.identity;
    const previousCanonical = canonicalOf(previousIdentity);
    const nextCanonical = canonicalOf(identity);
    this.generation += 1;
    this.attachmentState = attachmentState;
    this.identity = identity || null;
    this.candidates = candidates || [];
    this.lastResolvedAt = new Date().toISOString();

    if (previousCanonical !== nextCanonical) {
      this.editorIdentityState = 'not_checked';
      this.editorCandidates = [];
      this.transportOwnershipState = 'not_checked';
      this.setDeployReadiness({ state: 'not_checked' });
    }

    for (const handler of this._resetHandlers) {
      await handler({
        generation: this.generation,
        reason,
        previousIdentity,
        nextIdentity: this.identity,
      });
    }
  }
}

export async function withProjectContextGuard(projectContext, options, fn) {
  const startedGeneration = projectContext.generation;
  const readiness = projectContext.evaluateToolReadiness(options);
  if (!readiness.ok) return makeProjectToolResult(readiness.error);

  const result = await fn({
    generation: startedGeneration,
    identity: readiness.identity,
  });

  if (projectContext.generation !== startedGeneration) {
    return makeProjectToolResult(makeProjectError(
      PROJECT_ERROR_CODES.PROJECT_CONTEXT_CHANGED,
      'Project context changed while the tool was running.',
      { detailCode: PROJECT_ERROR_CODES.GENERATION_STALE },
    ));
  }
  return result;
}
