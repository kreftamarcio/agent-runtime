/**
 * agent-runtime: bounded execution for agent loops.
 *
 * An agent loop needs more than one stopping condition. A token budget alone
 * lets an agent burn fifteen iterations repeating itself before it trips.
 * Structural loop detection catches that in two or three, but cannot stop an
 * agent that is genuinely progressing yet too slowly to afford.
 *
 * IterationGuard combines three independent layers and reports which one fired,
 * because "stopped after 40 iterations" and "stopped repeating the same search"
 * demand completely different fixes.
 */

import { LoopDetector } from './safety/loop-detector';

import type {
  LoopDetectionConfig,
  CallRecord,
  LoopPattern,
  DetectionResult,
} from './safety/loop-detector';

export { LoopDetector };

export type { LoopDetectionConfig, CallRecord, LoopPattern, DetectionResult };

export const DEFAULT_LOOP_CONFIG: LoopDetectionConfig = {
  enabled: true,
  exactRepetitionThreshold: 3,
  cycleDetectionWindow: 8,
  notifyModel: true,
  noProgressThreshold: 4,
};

/** Why the loop stopped. Each value maps to a different corrective action. */
export type StopReason =
  | 'completed'
  | 'iteration_cap'
  | 'token_budget'
  | 'wall_clock'
  | 'loop_detected'
  | 'aborted';

export interface GuardLimits {
  /** Hard ceiling on iterations. The backstop when every other signal misses. */
  maxIterations: number;
  /** Cumulative token budget across the run. Omit for no token limit. */
  maxTokens?: number;
  /** Wall-clock budget in ms. Omit for no time limit. */
  maxDurationMs?: number;
  loop?: LoopDetectionConfig;
}

export interface IterationOutcome {
  tool: string;
  arguments: Record<string, unknown>;
  resultHash: string;
  ok: boolean;
  tokensUsed?: number;
}

export interface GuardVerdict {
  /** Whether the loop may run another iteration. */
  canContinue: boolean;
  reason: StopReason;
  /** Observation to inject into the conversation, when a loop was detected. */
  modelNotice?: string;
  pattern?: LoopPattern;
  usage: {
    iterations: number;
    tokens: number;
    elapsedMs: number;
  };
}

export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';

  constructor(
    readonly reason: StopReason,
    readonly usage: GuardVerdict['usage'],
  ) {
    super(`Agent run stopped: ${reason} (iterations=${usage.iterations}, tokens=${usage.tokens})`);
    this.name = 'BudgetExceededError';
  }
}

export class IterationGuard {
  private readonly detector: LoopDetector;
  private readonly limits: GuardLimits;
  private readonly startedAt: number;

  private iterations = 0;
  private tokens = 0;
  private aborted = false;

  constructor(limits: GuardLimits, now: number = Date.now()) {
    this.validate(limits);
    this.limits = limits;
    this.detector = new LoopDetector(limits.loop ?? DEFAULT_LOOP_CONFIG);
    this.startedAt = now;
  }

  /**
   * Record a completed iteration and decide whether the loop may continue.
   *
   * Limits are checked before loop detection: an exhausted budget is a hard
   * stop, while a detected loop is often recoverable by telling the model what
   * it is repeating. Checking the hard stops first avoids emitting advice the
   * agent has no remaining budget to act on.
   */
  record(outcome: IterationOutcome, now: number = Date.now()): GuardVerdict {
    this.iterations += 1;
    this.tokens += outcome.tokensUsed ?? 0;

    const record: CallRecord = {
      iteration: this.iterations,
      tool: outcome.tool,
      arguments: outcome.arguments,
      resultHash: outcome.resultHash,
      ok: outcome.ok,
    };
    this.detector.record(record);

    const usage = this.usage(now);

    if (this.aborted) {
      return { canContinue: false, reason: 'aborted', usage };
    }

    if (this.iterations >= this.limits.maxIterations) {
      return { canContinue: false, reason: 'iteration_cap', usage };
    }

    if (this.limits.maxTokens !== undefined && this.tokens >= this.limits.maxTokens) {
      return { canContinue: false, reason: 'token_budget', usage };
    }

    if (
      this.limits.maxDurationMs !== undefined &&
      usage.elapsedMs >= this.limits.maxDurationMs
    ) {
      return { canContinue: false, reason: 'wall_clock', usage };
    }

    const detection: DetectionResult = this.detector.check();
    if (detection.detected) {
      return {
        // A first detection with a notice is recoverable: the model gets told
        // what it is repeating and may change course. A repeat detection, where
        // the notice was already delivered and ignored, is a hard stop.
        canContinue: detection.modelNotice !== undefined,
        reason: 'loop_detected',
        modelNotice: detection.modelNotice,
        pattern: detection.pattern,
        usage,
      };
    }

    return { canContinue: true, reason: 'completed', usage };
  }

  /** Throwing variant, for callers that prefer control flow over branching. */
  assertCanContinue(verdict: GuardVerdict): void {
    if (verdict.canContinue) return;
    if (verdict.reason === 'loop_detected') return;
    throw new BudgetExceededError(verdict.reason, verdict.usage);
  }

  abort(): void {
    this.aborted = true;
  }

  usage(now: number = Date.now()): GuardVerdict['usage'] {
    return {
      iterations: this.iterations,
      tokens: this.tokens,
      elapsedMs: Math.max(0, now - this.startedAt),
    };
  }

  /** Fraction of each budget consumed, for telemetry and early warnings. */
  pressure(now: number = Date.now()): {
    iterations: number;
    tokens: number | null;
    duration: number | null;
  } {
    const usage = this.usage(now);
    return {
      iterations: usage.iterations / this.limits.maxIterations,
      tokens: this.limits.maxTokens ? usage.tokens / this.limits.maxTokens : null,
      duration: this.limits.maxDurationMs
        ? usage.elapsedMs / this.limits.maxDurationMs
        : null,
    };
  }

  reset(): void {
    this.iterations = 0;
    this.tokens = 0;
    this.aborted = false;
    this.detector.reset();
  }

  private validate(limits: GuardLimits): void {
    if (!Number.isInteger(limits.maxIterations) || limits.maxIterations < 1) {
      throw new Error(
        `maxIterations must be a positive integer, got ${limits.maxIterations}`,
      );
    }
    if (limits.maxTokens !== undefined && limits.maxTokens <= 0) {
      throw new Error(`maxTokens must be positive when set, got ${limits.maxTokens}`);
    }
    if (limits.maxDurationMs !== undefined && limits.maxDurationMs <= 0) {
      throw new Error(
        `maxDurationMs must be positive when set, got ${limits.maxDurationMs}`,
      );
    }
  }
}
