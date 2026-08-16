/**
 * Permission gate for agent tool calls.
 *
 * IMPORTANT, and stated first because the distinction must never blur: this is a
 * POLICY boundary, not a security boundary. A tool handler executes real code with the
 * privileges of this process. Argument validation stops accidents and
 * prompt-injected misuse of legitimate tools. It does not contain a malicious handler.
 *
 * Describing it as a sandbox would give operators false confidence, which is worse than
 * having no gate, because it removes the incentive to add real process isolation.
 *
 * What it does provide:
 *   - Deny-by-default tool access
 *   - Filesystem scoping with traversal and symlink defeat resistance
 *   - Network host allow-listing
 *   - A decision record for every check, so a denial is explainable
 */

import { resolve, sep, isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';

export type Capability = 'filesystem:read' | 'filesystem:write' | 'network' | 'tool';

export interface PermissionPolicy {
  /**
   * Tools callable at all. Deny-by-default: absence means denied.
   *
   * The inverse default means registering a tool silently expands agent authority,
   * and a config that grows by omission is never reviewed.
   */
  tools: { allow: string[]; deny?: string[] };
  filesystem?: {
    /** Absolute directory roots readable by the agent. */
    read?: string[];
    /** Absolute directory roots writable by the agent. */
    write?: string[];
  };
  network?: {
    /** Hostnames the agent may reach. Exact match or a leading '*.' wildcard. */
    allow?: string[];
    deny?: string[];
  };
}

export interface PermissionRequest {
  tool: string;
  capability: Capability;
  /** Filesystem path, for filesystem capabilities. */
  path?: string;
  /** Hostname, for the network capability. */
  host?: string;
}

export type PermissionDecision =
  | { granted: true; capability: Capability; resolvedPath?: string }
  | { granted: false; capability: Capability; reason: string; code: DenialCode };

export type DenialCode =
  | 'TOOL_NOT_ALLOWED'
  | 'TOOL_EXPLICITLY_DENIED'
  | 'PATH_OUTSIDE_SCOPE'
  | 'PATH_TRAVERSAL'
  | 'PATH_NOT_ABSOLUTE'
  | 'SYMLINK_ESCAPE'
  | 'HOST_NOT_ALLOWED'
  | 'HOST_EXPLICITLY_DENIED'
  | 'CAPABILITY_NOT_CONFIGURED'
  | 'MISSING_ARGUMENT';

export interface DecisionRecord {
  timestamp: string;
  request: PermissionRequest;
  decision: PermissionDecision;
}

export class PermissionGate {
  private readonly policy: PermissionPolicy;
  private readonly allowedTools: Set<string>;
  private readonly deniedTools: Set<string>;
  private readonly readRoots: string[];
  private readonly writeRoots: string[];
  private readonly decisions: DecisionRecord[] = [];

  constructor(policy: PermissionPolicy) {
    this.policy = policy;
    this.allowedTools = new Set(policy.tools.allow);
    this.deniedTools = new Set(policy.tools.deny ?? []);

    // A name in both lists is a config contradiction. Resolving it silently in either
    // direction hides an operator mistake about what is actually callable.
    const conflicts = [...this.allowedTools].filter((t) => this.deniedTools.has(t));
    if (conflicts.length > 0) {
      throw new Error(
        `Tool(s) [${conflicts.join(', ')}] appear in both allow and deny. Resolve the ` +
          'contradiction explicitly rather than relying on precedence.',
      );
    }

    // Roots are normalized once at construction. Doing it per check would repeat the
    // work on every call and risk one path being normalized while another is not.
    this.readRoots = this.normalizeRoots(policy.filesystem?.read ?? [], 'read');
    this.writeRoots = this.normalizeRoots(policy.filesystem?.write ?? [], 'write');
  }

  /**
   * Synchronous check.
   *
   * Resolves '..' and normalizes separators, but does NOT resolve symlinks, which
   * requires I/O. Use checkAsync for filesystem capabilities on a path that could be a
   * symlink, which in practice means any path the agent supplied.
   */
  check(request: PermissionRequest): PermissionDecision {
    const decision = this.evaluate(request);
    this.record(request, decision);
    return decision;
  }

  /**
   * Check with symlink resolution.
   *
   * A symlink inside an allowed directory pointing outside it defeats every purely
   * lexical check, so containment is verified against the real path. This is the
   * version to use for anything the model produced.
   */
  async checkAsync(request: PermissionRequest): Promise<PermissionDecision> {
    const lexical = this.evaluate(request);

    if (!lexical.granted || request.path === undefined) {
      this.record(request, lexical);
      return lexical;
    }

    const roots =
      request.capability === 'filesystem:write' ? this.writeRoots : this.readRoots;

    try {
      const real = await realpath(lexical.resolvedPath ?? request.path);

      if (!this.isContained(real, roots)) {
        const denial: PermissionDecision = {
          granted: false,
          capability: request.capability,
          code: 'SYMLINK_ESCAPE',
          reason:
            `Path "${request.path}" resolves through a symlink to "${real}", which is ` +
            'outside every configured root. Lexical containment passed but real ' +
            'containment did not.',
        };
        this.record(request, denial);
        return denial;
      }

      const granted: PermissionDecision = {
        granted: true,
        capability: request.capability,
        resolvedPath: real,
      };
      this.record(request, granted);
      return granted;
    } catch {
      // ENOENT is expected for a write to a file that does not exist yet. The lexical
      // check already confirmed the target directory is in scope, so this is not a
      // denial. Failing here would make it impossible to create any new file.
      this.record(request, lexical);
      return lexical;
    }
  }

  private evaluate(request: PermissionRequest): PermissionDecision {
    // Tool access is checked first regardless of capability. A denied tool cannot be
    // reached through any capability, so evaluating path scope first would waste work
    // and could log a path for a call that was never permitted.
    if (this.deniedTools.has(request.tool)) {
      return {
        granted: false,
        capability: request.capability,
        code: 'TOOL_EXPLICITLY_DENIED',
        reason: `Tool "${request.tool}" is explicitly denied`,
      };
    }

    if (!this.allowedTools.has(request.tool)) {
      return {
        granted: false,
        capability: request.capability,
        code: 'TOOL_NOT_ALLOWED',
        reason:
          `Tool "${request.tool}" is not in the allow-list. Access is deny-by-default, ` +
          'so a tool must be explicitly permitted before it is callable.',
      };
    }

    switch (request.capability) {
      case 'tool':
        return { granted: true, capability: request.capability };

      case 'filesystem:read':
        return this.checkPath(request, this.readRoots, 'read');

      case 'filesystem:write':
        return this.checkPath(request, this.writeRoots, 'write');

      case 'network':
        return this.checkHost(request);
    }
  }

  private checkPath(
    request: PermissionRequest,
    roots: string[],
    label: string,
  ): PermissionDecision {
    if (request.path === undefined) {
      return {
        granted: false,
        capability: request.capability,
        code: 'MISSING_ARGUMENT',
        reason: `Capability ${request.capability} requires a path`,
      };
    }

    if (roots.length === 0) {
      return {
        granted: false,
        capability: request.capability,
        code: 'CAPABILITY_NOT_CONFIGURED',
        reason:
          `No filesystem ${label} roots are configured, so every ${label} is denied. ` +
          'This is the deny-by-default posture, not a misconfiguration.',
      };
    }

    // A relative path is resolved against process.cwd(), which is not the agent's
    // notion of "here" and varies by how the process was launched. Requiring absolute
    // paths removes that ambiguity rather than guessing at it.
    if (!isAbsolute(request.path)) {
      return {
        granted: false,
        capability: request.capability,
        code: 'PATH_NOT_ABSOLUTE',
        reason:
          `Path "${request.path}" is relative. Relative paths resolve against the ` +
          'process working directory, which is not a stable reference for an agent.',
      };
    }

    // resolve() collapses '..' segments. This is the step that defeats traversal:
    // "/workspace/../../etc/passwd" becomes "/etc/passwd" and then fails containment,
    // whereas a prefix match on the raw string would have passed.
    const resolved = resolve(request.path);

    if (!this.isContained(resolved, roots)) {
      // Traversal is reported distinctly from a plainly out-of-scope path, because one
      // is a likely attack and the other is usually a mistake.
      const looksLikeTraversal = request.path.includes('..');

      return {
        granted: false,
        capability: request.capability,
        code: looksLikeTraversal ? 'PATH_TRAVERSAL' : 'PATH_OUTSIDE_SCOPE',
        reason: looksLikeTraversal
          ? `Path "${request.path}" traverses out of scope, resolving to "${resolved}"`
          : `Path "${resolved}" is outside every configured ${label} root`,
      };
    }

    return { granted: true, capability: request.capability, resolvedPath: resolved };
  }

  private checkHost(request: PermissionRequest): PermissionDecision {
    if (request.host === undefined) {
      return {
        granted: false,
        capability: request.capability,
        code: 'MISSING_ARGUMENT',
        reason: 'Capability network requires a host',
      };
    }

    // Lowercased because hostnames are case-insensitive, and a policy written in
    // lowercase must not be bypassed by an uppercase request.
    const host = request.host.toLowerCase();

    if ((this.policy.network?.deny ?? []).some((p) => this.hostMatches(host, p))) {
      return {
        granted: false,
        capability: request.capability,
        code: 'HOST_EXPLICITLY_DENIED',
        reason: `Host "${host}" is explicitly denied`,
      };
    }

    const allow = this.policy.network?.allow ?? [];

    if (allow.length === 0) {
      return {
        granted: false,
        capability: request.capability,
        code: 'CAPABILITY_NOT_CONFIGURED',
        reason: 'No network hosts are allow-listed, so every request is denied',
      };
    }

    if (!allow.some((p) => this.hostMatches(host, p))) {
      return {
        granted: false,
        capability: request.capability,
        code: 'HOST_NOT_ALLOWED',
        reason: `Host "${host}" is not in the allow-list`,
      };
    }

    return { granted: true, capability: request.capability };
  }

  /**
   * Containment check.
   *
   * The trailing separator matters: without it, "/workspace-evil" passes a
   * startsWith("/workspace") test. Comparing against `root + sep` makes it a genuine
   * directory containment rather than a string prefix.
   */
  private isContained(candidate: string, roots: readonly string[]): boolean {
    return roots.some((root) => candidate === root || candidate.startsWith(root + sep));
  }

  /** Exact match, or a single-label wildcard: '*.example.com' matches 'api.example.com'. */
  private hostMatches(host: string, pattern: string): boolean {
    const lowered = pattern.toLowerCase();

    if (lowered.startsWith('*.')) {
      const suffix = lowered.slice(1); // '.example.com'
      // Requires an actual subdomain: '*.example.com' must not match 'example.com',
      // because the apex and its subdomains are frequently different services.
      return host.endsWith(suffix) && host.length > suffix.length;
    }

    return host === lowered;
  }

  private normalizeRoots(roots: readonly string[], label: string): string[] {
    return roots.map((root) => {
      if (!isAbsolute(root)) {
        throw new Error(
          `Filesystem ${label} root "${root}" is not absolute. A relative root ` +
            'resolves against the process working directory, so the scope would change ' +
            'depending on how the process was launched.',
        );
      }
      return resolve(root);
    });
  }

  private record(request: PermissionRequest, decision: PermissionDecision): void {
    this.decisions.push({
      timestamp: new Date().toISOString(),
      request,
      decision,
    });
  }

  /**
   * Denial history.
   *
   * Exposed because a repeated denial of the same tool is a signal, not noise: either
   * the agent needs a capability it does not have, or something is repeatedly trying
   * to reach past its boundary.
   */
  getDenials(): DecisionRecord[] {
    return this.decisions.filter((d) => !d.decision.granted);
  }

  stats(): {
    total: number;
    granted: number;
    denied: number;
    byCode: Record<string, number>;
    mostDeniedTool: string | null;
  } {
    const byCode: Record<string, number> = {};
    const byTool: Record<string, number> = {};
    let granted = 0;

    for (const record of this.decisions) {
      if (record.decision.granted) {
        granted++;
        continue;
      }

      byCode[record.decision.code] = (byCode[record.decision.code] ?? 0) + 1;
      byTool[record.request.tool] = (byTool[record.request.tool] ?? 0) + 1;
    }

    const mostDenied = Object.entries(byTool).sort((a, b) => b[1] - a[1])[0];

    return {
      total: this.decisions.length,
      granted,
      denied: this.decisions.length - granted,
      byCode,
      mostDeniedTool: mostDenied?.[0] ?? null,
    };
  }

  clearHistory(): void {
    this.decisions.length = 0;
  }
}
