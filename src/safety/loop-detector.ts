/**
 * Loop detection for agent reasoning cycles.
 *
 * Budget limits eventually stop a runaway agent, but expensively: by the time
 * a token budget trips, the agent may have burned fifteen iterations doing the
 * same thing. Structural detection catches it in two or three.
 *
 * Three independent signals:
 *   1. Exact repetition  - identical tool + arguments, N times consecutively
 *   2. Cyclic pattern    - repeating sequence such as A,B,A,B,A,B
 *   3. No progress       - calls continue but results stop changing
 *
 * On detection the reason is surfaced rather than silently halting, because
 * telling the model what it is repeating frequently unsticks it, whereas
 * halting turns a recoverable situation into a failed task.
 */

import { createHash } from 'node:crypto';

export interface LoopDetectionConfig {
  enabled: boolean;
  /** Consecutive identical calls that constitute a loop. */
  exactRepetitionThreshold: number;
  /** How many recent calls to scan for cyclic patterns. */
  cycleDetectionWindow: number;
  /** Feed the detection back to the model instead of halting immediately. */
  notifyModel: boolean;
  /** Consecutive calls with unchanged results that count as no progress. */
  noProgressThreshold?: number;
}

export interface CallRecord {
  iteration: number;
  tool: string;
  arguments: Record<string, unknown>;
  /** Hash of the result, used for progress detection without retaining payloads. */
  resultHash: string;
  ok: boolean;
}

export type LoopPattern =
  | { kind: 'exact_repetition'; tool: string; count: number; signature: string }
  | { kind: 'cycle'; period: number; sequence: string[]; repetitions: number }
  | { kind: 'no_progress'; count: number; tools: string[] };

export interface DetectionResult {
  detected: boolean;
  pattern?: LoopPattern;
  /** Message suitable for injecting into the conversation as an observation. */
  modelNotice?: string;
  /** Iterations examined to reach this conclusion. */
  iterationsExamined: number;
}

const DEFAULT_NO_PROGRESS_THRESHOLD = 4;

export class LoopDetector {
  private readonly config: Required<LoopDetectionConfig>;
  private history: CallRecord[] = [];

  /** Signatures already reported, so the same loop is not flagged repeatedly. */
  private readonly reported = new Set<string>();

  constructor(config: LoopDetectionConfig) {
    this.validate(config);
    this.config = {
      ...config,
      noProgressThreshold: config.noProgressThreshold ?? DEFAULT_NO_PROGRESS_THRESHOLD,
    };
  }

  record(call: CallRecord): void {
    this.history.push(call);

    // Bound memory. Retaining more than twice the cycle window serves no
    // detection purpose and grows without limit on long runs.
    const maxHistory = Math.max(this.config.cycleDetectionWindow * 2, 32);
    if (this.history.length > maxHistory) {
      this.history = this.history.slice(-maxHistory);
    }
  }

  /**
   * Evaluate all signals against the current history.
   * Checked in order of confidence: exact repetition is the least ambiguous.
   */
  check(): DetectionResult {
    if (!this.config.enabled || this.history.length < 2) {
      return { detected: false, iterationsExamined: this.history.length };
    }

    const exact = this.detectExactRepetition();
    if (exact) return this.result(exact);

    const cycle = this.detectCycle();
    if (cycle) return this.result(cycle);

    const stalled = this.detectNoProgress();
    if (stalled) return this.result(stalled);

    return { detected: false, iterationsExamined: this.history.length };
  }

  /**
   * Identical tool with identical arguments, N times consecutively.
   *
   * This is the least ambiguous signal available. A deterministic tool called
   * with identical arguments returns an identical result, so repeating the call
   * cannot produce new information.
   */
  private detectExactRepetition(): LoopPattern | null {
    const threshold = this.config.exactRepetitionThreshold;
    if (this.history.length < threshold) return null;

    const recent = this.history.slice(-threshold);
    const signature = this.signatureOf(recent[0]!);

    const allIdentical = recent.every(call => this.signatureOf(call) === signature);
    if (!allIdentical) return null;

    return {
      kind: 'exact_repetition',
      tool: recent[0]!.tool,
      count: threshold,
      signature,
    };
  }

  /**
   * Repeating sequence detection.
   *
   * Searches for the smallest period p such that the last k*p calls consist of
   * the same p-length block repeated k times, with k >= 2.
   *
   * Smallest period first matters: an A,B,A,B sequence has period 2, but also
   * trivially satisfies period 4. Reporting period 2 is the useful description.
   *
   * Periods start at 2 because period 1 is exact repetition, already covered by
   * a more specific check with its own threshold.
   */
  private detectCycle(): LoopPattern | null {
    const window = Math.min(this.config.cycleDetectionWindow, this.history.length);
    const signatures = this.history.slice(-window).map(c => this.signatureOf(c));

    const maxPeriod = Math.floor(signatures.length / 2);

    for (let period = 2; period <= maxPeriod; period++) {
      const repetitions = Math.floor(signatures.length / period);
      if (repetitions < 2) continue;

      const tail = signatures.slice(-(period * repetitions));
      const block = tail.slice(0, period);

      let matches = true;
      for (let r = 1; r < repetitions && matches; r++) {
        for (let i = 0; i < period; i++) {
          if (tail[r * period + i] !== block[i]) {
            matches = false;
            break;
          }
        }
      }

      if (matches) {
        const startIndex = this.history.length - period * repetitions;
        return {
          kind: 'cycle',
          period,
          sequence: this.history.slice(startIndex, startIndex + period).map(c => c.tool),
          repetitions,
        };
      }
    }

    return null;
  }

  /**
   * Calls continue but results stop changing.
   *
   * Distinct from exact repetition: the agent may be varying its arguments
   * (different search phrasings, different paths) while every attempt returns
   * the same thing. It is active but not advancing.
   *
   * Only successful calls are considered. A run of failures is a different
   * problem, handled by retry policy rather than loop detection.
   */
  private detectNoProgress(): LoopPattern | null {
    const threshold = this.config.noProgressThreshold;
    if (this.history.length < threshold) return null;

    const recent = this.history.slice(-threshold);
    if (!recent.every(c => c.ok)) return null;

    const firstHash = recent[0]!.resultHash;
    const allSameResult = recent.every(c => c.resultHash === firstHash);
    if (!allSameResult) return null;

    // Identical arguments too means this is exact repetition, already reported
    // by the more specific check. Avoid double-flagging the same behaviour.
    const firstSignature = this.signatureOf(recent[0]!);
    if (recent.every(c => this.signatureOf(c) === firstSignature)) {
      return null;
    }

    return {
      kind: 'no_progress',
      count: threshold,
      tools: [...new Set(recent.map(c => c.tool))],
    };
  }

  /**
   * Build the observation injected into the conversation.
   *
   * Phrasing is deliberately factual and specific. "You seem stuck" gives the
   * model nothing to act on. Naming the exact repeated call and its outcome
   * gives it enough to change approach.
   */
  private noticeFor(pattern: LoopPattern): string {
    switch (pattern.kind) {
      case 'exact_repetition':
        return (
          `You have called "${pattern.tool}" with identical arguments ` +
          `${pattern.count} times in a row, receiving the same result each time. ` +
          `Repeating it will not produce new information. Either change the ` +
          `arguments, use a different tool, or report what you have concluded ` +
          `with the information already available.`
        );

      case 'cycle':
        return (
          `You are repeating the sequence [${pattern.sequence.join(' -> ')}] ` +
          `and have completed it ${pattern.repetitions} times. This cycle is not ` +
          `making progress. Reconsider your approach, or state what is blocking you.`
        );

      case 'no_progress':
        return (
          `Your last ${pattern.count} tool calls (${pattern.tools.join(', ')}) ` +
          `all returned the same result despite different arguments. The ` +
          `information you are looking for may not be available through these ` +
          `tools. Consider stating what is missing rather than continuing to search.`
        );
    }
  }

  /**
   * Stable signature for a call: tool name plus canonically-serialized
   * arguments.
   *
   * Keys are sorted before hashing because `{a:1,b:2}` and `{b:2,a:1}` are the
   * same call, and JSON.stringify preserves insertion order. Without sorting,
   * the same logical call could produce different signatures and defeat
   * detection entirely.
   */
  private signatureOf(call: CallRecord): string {
    const canonical = this.canonicalize(call.arguments);
    return createHash('sha256')
      .update(`${call.tool}:${JSON.stringify(canonical)}`)
      .digest('hex')
      .slice(0, 16);
  }

  private canonicalize(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;

    if (Array.isArray(value)) {
      return value.map(v => this.canonicalize(v));
    }

    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, this.canonicalize(v)] as const);

    return Object.fromEntries(entries);
  }

  private result(pattern: LoopPattern): DetectionResult {
    const key = this.patternKey(pattern);

    // Already reported: keep detected true so the caller can still halt if it
    // chooses, but suppress a duplicate notice to the model.
    const alreadyReported = this.reported.has(key);
    this.reported.add(key);

    return {
      detected: true,
      pattern,
      modelNotice:
        this.config.notifyModel && !alreadyReported
          ? this.noticeFor(pattern)
          : undefined,
      iterationsExamined: this.history.length,
    };
  }

  private patternKey(pattern: LoopPattern): string {
    switch (pattern.kind) {
      case 'exact_repetition':
        return `exact:${pattern.signature}`;
      case 'cycle':
        return `cycle:${pattern.period}:${pattern.sequence.join(',')}`;
      case 'no_progress':
        return `stalled:${pattern.tools.sort().join(',')}`;
    }
  }

  reset(): void {
    this.history = [];
    this.reported.clear();
  }

  private validate(config: LoopDetectionConfig): void {
    if (config.exactRepetitionThreshold < 2) {
      throw new Error(
        `exactRepetitionThreshold must be at least 2, got ${config.exactRepetitionThreshold}. ` +
        `A threshold of 1 would flag every single call as a repetition.`,
      );
    }

    if (config.cycleDetectionWindow < 4) {
      throw new Error(
        `cycleDetectionWindow must be at least 4, got ${config.cycleDetectionWindow}. ` +
        `Detecting a period-2 cycle requires observing it at least twice.`,
      );
    }

    if (config.noProgressThreshold !== undefined && config.noProgressThreshold < 2) {
      throw new Error('noProgressThreshold must be at least 2');
    }
  }
}
