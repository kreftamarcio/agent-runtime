import { describe, it, expect } from 'vitest';
import { LoopDetector } from '../src/safety/loop-detector';
import type { CallRecord, LoopDetectionConfig } from '../src/safety/loop-detector';

const config: LoopDetectionConfig = {
  enabled: true,
  exactRepetitionThreshold: 3,
  cycleDetectionWindow: 8,
  notifyModel: true,
  noProgressThreshold: 4,
};

let iteration = 0;

function record(
  tool: string,
  args: Record<string, unknown> = {},
  resultHash = 'hash-default',
  ok = true,
): CallRecord {
  iteration += 1;
  return { iteration, tool, arguments: args, resultHash, ok };
}

function feed(detector: LoopDetector, records: CallRecord[]): void {
  for (const r of records) detector.record(r);
}

describe('configuration guardrails', () => {
  it('rejects an exact-repetition threshold of 1', () => {
    expect(
      () => new LoopDetector({ ...config, exactRepetitionThreshold: 1 }),
    ).toThrow(/at least 2/);
  });

  it('rejects a cycle window too small to observe a period-2 cycle twice', () => {
    expect(() => new LoopDetector({ ...config, cycleDetectionWindow: 3 })).toThrow(
      /at least 4/,
    );
  });
});

describe('exact repetition', () => {
  it('does not flag anything below the threshold', () => {
    const detector = new LoopDetector(config);
    feed(detector, [
      record('search', { q: 'typescript' }, 'h1'),
      record('search', { q: 'typescript' }, 'h1'),
    ]);

    expect(detector.check().detected).toBe(false);
  });

  it('flags identical tool and arguments at the threshold', () => {
    const detector = new LoopDetector(config);
    feed(detector, [
      record('search', { q: 'typescript' }, 'h1'),
      record('search', { q: 'typescript' }, 'h1'),
      record('search', { q: 'typescript' }, 'h1'),
    ]);

    const result = detector.check();
    expect(result.detected).toBe(true);
    expect(result.pattern?.kind).toBe('exact_repetition');
  });

  it('treats reordered argument keys as the same call', () => {
    const detector = new LoopDetector(config);
    feed(detector, [
      record('search', { a: 1, b: 2 }, 'h1'),
      record('search', { b: 2, a: 1 }, 'h1'),
      record('search', { a: 1, b: 2 }, 'h1'),
    ]);

    expect(detector.check().pattern?.kind).toBe('exact_repetition');
  });

  it('does not flag the same tool with genuinely different arguments', () => {
    const detector = new LoopDetector(config);
    feed(detector, [
      record('search', { q: 'a' }, 'h1'),
      record('search', { q: 'b' }, 'h2'),
      record('search', { q: 'c' }, 'h3'),
    ]);

    expect(detector.check().detected).toBe(false);
  });

  it('includes the repeated tool name in the model notice', () => {
    const detector = new LoopDetector(config);
    feed(detector, [
      record('readFile', { path: '/tmp/a' }, 'h1'),
      record('readFile', { path: '/tmp/a' }, 'h1'),
      record('readFile', { path: '/tmp/a' }, 'h1'),
    ]);

    expect(detector.check().modelNotice).toContain('readFile');
  });

  it('suppresses a duplicate notice for an already reported pattern', () => {
    const detector = new LoopDetector(config);
    feed(detector, [
      record('search', { q: 'x' }, 'h1'),
      record('search', { q: 'x' }, 'h1'),
      record('search', { q: 'x' }, 'h1'),
    ]);

    expect(detector.check().modelNotice).toBeDefined();

    const second = detector.check();
    expect(second.detected).toBe(true);
    expect(second.modelNotice).toBeUndefined();
  });
});

describe('cycle detection', () => {
  it('detects an A,B,A,B pattern and reports period 2', () => {
    const detector = new LoopDetector(config);
    feed(detector, [
      record('list', { dir: '/' }, 'h1'),
      record('read', { file: 'a' }, 'h2'),
      record('list', { dir: '/' }, 'h1'),
      record('read', { file: 'a' }, 'h2'),
    ]);

    const pattern = detector.check().pattern;
    expect(pattern?.kind).toBe('cycle');
    if (pattern?.kind === 'cycle') {
      expect(pattern.period).toBe(2);
      expect(pattern.sequence).toEqual(['list', 'read']);
    }
  });

  it('prefers the smallest period over a trivially matching multiple', () => {
    const detector = new LoopDetector(config);
    feed(detector, [
      record('a', { i: 1 }, 'h1'),
      record('b', { i: 2 }, 'h2'),
      record('a', { i: 1 }, 'h1'),
      record('b', { i: 2 }, 'h2'),
      record('a', { i: 1 }, 'h1'),
      record('b', { i: 2 }, 'h2'),
    ]);

    const pattern = detector.check().pattern;
    if (pattern?.kind === 'cycle') {
      expect(pattern.period).toBe(2);
    }
  });

  it('leaves a non-repeating sequence alone', () => {
    const detector = new LoopDetector(config);
    feed(detector, [
      record('a', { i: 1 }, 'h1'),
      record('b', { i: 2 }, 'h2'),
      record('c', { i: 3 }, 'h3'),
      record('d', { i: 4 }, 'h4'),
    ]);

    expect(detector.check().detected).toBe(false);
  });
});

describe('no progress', () => {
  it('flags varied arguments that keep returning the same result', () => {
    const detector = new LoopDetector(config);
    feed(detector, [
      record('search', { q: 'one' }, 'same'),
      record('search', { q: 'two' }, 'same'),
      record('search', { q: 'three' }, 'same'),
      record('search', { q: 'four' }, 'same'),
    ]);

    const pattern = detector.check().pattern;
    expect(pattern?.kind).toBe('no_progress');
  });

  it('ignores runs of failures, which belong to retry policy', () => {
    const detector = new LoopDetector(config);
    feed(detector, [
      record('search', { q: 'one' }, 'same', false),
      record('search', { q: 'two' }, 'same', false),
      record('search', { q: 'three' }, 'same', false),
      record('search', { q: 'four' }, 'same', false),
    ]);

    expect(detector.check().detected).toBe(false);
  });

  it('does not double-report when the calls are also identical', () => {
    const detector = new LoopDetector({
      ...config,
      exactRepetitionThreshold: 10,
      noProgressThreshold: 4,
    });

    feed(detector, [
      record('search', { q: 'same' }, 'same'),
      record('search', { q: 'same' }, 'same'),
      record('search', { q: 'same' }, 'same'),
      record('search', { q: 'same' }, 'same'),
    ]);

    // Identical arguments make this exact repetition, which has not hit its own
    // threshold of 10. no_progress must not claim it.
    expect(detector.check().detected).toBe(false);
  });
});

describe('lifecycle', () => {
  it('reports nothing while disabled', () => {
    const detector = new LoopDetector({ ...config, enabled: false });
    feed(detector, [
      record('search', { q: 'x' }, 'h1'),
      record('search', { q: 'x' }, 'h1'),
      record('search', { q: 'x' }, 'h1'),
    ]);

    expect(detector.check().detected).toBe(false);
  });

  it('omits the notice when model notification is off', () => {
    const detector = new LoopDetector({ ...config, notifyModel: false });
    feed(detector, [
      record('search', { q: 'x' }, 'h1'),
      record('search', { q: 'x' }, 'h1'),
      record('search', { q: 'x' }, 'h1'),
    ]);

    const result = detector.check();
    expect(result.detected).toBe(true);
    expect(result.modelNotice).toBeUndefined();
  });

  it('clears history and reported patterns on reset', () => {
    const detector = new LoopDetector(config);
    feed(detector, [
      record('search', { q: 'x' }, 'h1'),
      record('search', { q: 'x' }, 'h1'),
      record('search', { q: 'x' }, 'h1'),
    ]);
    expect(detector.check().detected).toBe(true);

    detector.reset();
    expect(detector.check().detected).toBe(false);
    expect(detector.check().iterationsExamined).toBe(0);
  });
});
