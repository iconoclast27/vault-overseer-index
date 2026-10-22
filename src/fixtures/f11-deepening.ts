// =============================================================================
// Vault Overseer — Fixture F11 Deepening (Hostile Encore)
// vault-overseer-index/src/fixtures/f11-deepening.ts
// Generated: 2026-10-22T12:15:00+01:00
//
// The "passed on first contact, hasn't been hostile enough" debt. Five
// scenarios stressing torn-tail + checkpoint interaction, buffer boundary,
// back-to-back checkpoints, intermediate chain segments, and rollback.
//
// Scenarios:
//   1. torn-tail pending → first append → checkpoint
//      (realistic: a torn fragment is on disk, startup detects it, the
//       first append buries it, then a checkpoint lands over the dead line)
//   2. buffer at checkpoint boundary (Tier-2 events, auto-checkpoint disabled)
//   3. back-to-back checkpoints with ZERO data between  ← PROBE
//   4. intermediate chain segment assertion (weak; needs writer instrumentation)
//   5. checkpoint rollback on write failure
//
// PROBE NOTICE (scenario 3): the writer's computeChain() returns the max seq
// over ALL parsable lines — INCLUDING prior checkpoints — while verifyChain()
// counts only NON-checkpoint lines for its positional witness. A checkpoint
// emitted immediately after another therefore claims a last_seq one higher
// than the verifier's dataMax, and verification should FAIL with a coverage
// violation. Scenario 3 asserts the CORRECT behaviour (cp2.last_seq === 5),
// so a red here is the FINDING, not a regression. Fix (if confirmed) lives in
// checkpoint.ts: exclude `log.checkpoint` lines from computeChain's lastSeq.
//
// Run: node ./src/fixtures/f11-deepening.ts
// =============================================================================

import { FakeFileSystem, FakeAdapter, spawnContext, shardPath, validLine } from '../test-harness.ts';
import { startupChecks } from '../eventlog/reader.ts';
import { verifyChain, computeChain, genesisDigest } from '../eventlog/checkpoint.ts';

const ROOT = '/f11-deepening';
const DIR = '_vault-index/events';
const ORIGIN = 'mokka';
const FIXED_TS = '2026-10-21T13:00:00+01:00';
const THRESHOLD = 10;              // shortened for test speed; production default is 10k
const BUFFER_COUNT = 64;           // Tier-2 flush threshold
const IDLE_MS_DISABLED = 60_000;   // 60s — effectively disables idle flush

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
    if (ok) {
        console.log(`[PASS] ${name}`);
    } else {
        failures++;
        console.log(`[FAIL] ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
    }
}

// --- Helpers (local; never import from another fixture — import RUNS it) ------

function splitByteLines(raw: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    let start = 0;
    for (let i = 0; i < raw.length; i++) {
        if (raw[i] === 0x0a) {
            out.push(raw.slice(start, i));
            start = i + 1;
        }
    }
    if (start < raw.length) out.push(raw.slice(start));
    return out;
}

function joinByteLines(lines: Uint8Array[]): Uint8Array {
    return Buffer.concat(lines.map((l) => Buffer.concat([l, Buffer.from('\n')])));
}

function countSubstring(raw: Uint8Array, needle: string): number {
    return Buffer.from(raw).toString('utf-8').split(needle).length - 1;
}

function tryParse(line: Uint8Array): Record<string, unknown> | null {
    try {
        return JSON.parse(Buffer.from(line).toString('utf-8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function findCheckpoint(lines: Uint8Array[]): number {
    return lines.findIndex((l) => l.toString().includes('"type":"log.checkpoint"'));
}

interface CtxOpts {
    initialSeq?: number;
    hasTornTail?: boolean;
    checkpointInterval?: number;
    tier2IdleMs?: number;
}

function newCtx(fs: FakeFileSystem, opts: CtxOpts = {}) {
    return spawnContext(ORIGIN, ROOT, {
        fs,
        now: () => FIXED_TS,
                        initialSeq: opts.initialSeq ?? 0,
                        hasTornTail: opts.hasTornTail ?? false,
                        settings: {
                            checkpointInterval: opts.checkpointInterval ?? THRESHOLD,
                        tier2IdleMs: opts.tier2IdleMs ?? IDLE_MS_DISABLED,
                        },
    });
}

async function appendTier1Notes(
    ctx: ReturnType<typeof newCtx>,
    prefix: string,
    count: number,
    seqBase = 0,
): Promise<void> {
    for (let i = 0; i < count; i++) {
        await ctx.log.appendEvent('user', 'note.created', {
            path: `Notes/${prefix}-${i}.md`,
            mtime: 1763000000000 + seqBase + i,
            bytes: 100,
            content_sha: `e3b0c44219fb${String(seqBase + i).padStart(4, '0')}`,
        });
    }
}

async function appendTier2Chunks(
    ctx: ReturnType<typeof newCtx>,
    prefix: string,
    count: number,
    seqBase = 0,
): Promise<void> {
    for (let i = 0; i < count; i++) {
        await ctx.log.appendEvent('plugin', 'chunk.indexed', {
            path: `Notes/${prefix}-${i}.md`,
            ord: i,
            bs: i * 50,
            be: i * 50 + 50,
            vh: `abc123${String(seqBase + i).padStart(6, '0')}`,
                                  cp: 3,
        });
    }
}

// --- Scenario 1: torn-tail pending → first append → checkpoint --------------

async function scenarioTornTailCheckpoint(): Promise<void> {
    console.log('\n=== F11 deepening scenario: torn-tail pending → checkpoint ===');
    const fs = new FakeFileSystem();
    const SHARD = shardPath(ROOT, ORIGIN);

    // Craft: two valid events, then a torn fragment (NO trailing newline).
    const head =
    validLine(1, 'note.created', {
        path: 'Notes/torn-a.md', mtime: 1763000000000, bytes: 100,
        content_sha: 'aaaa000000000001',
    }) +
    validLine(2, 'note.created', {
        path: 'Notes/torn-b.md', mtime: 1763000000001, bytes: 100,
        content_sha: 'aaaa000000000002',
    }) +
    '{"v":1,"seq":3,"ts":"2026-10-21T13:00:00+01:00","origin":"mokka","actor":"plug';
        fs.write(SHARD, head);

        // Startup must detect the torn tail and recover through seq 2.
        const adapter = new FakeAdapter(fs, ROOT);
        const su = await startupChecks(adapter, ORIGIN, DIR);
        check('torn-tail: startup detects torn tail', su.tornTail === true);
        check('torn-tail: startup recovers through seq 2',
              su.recoveredThroughSeq === 2, `got ${su.recoveredThroughSeq}`);

        // Fresh context primed with the torn-tail flag (harness must forward it).
        const ctx = newCtx(fs, {
            initialSeq: su.recoveredThroughSeq,
            hasTornTail: su.tornTail,
        });

        // First append buries the fragment; five appends then dispose → checkpoint.
        await appendTier1Notes(ctx, 'torn', 5);
        await ctx.log.dispose();

        const raw = fs.getBytes(SHARD)!;
        const lines = splitByteLines(raw);

        // Expected: e1, e2, buried-fragment, a1..a5, checkpoint = 9 lines.
        check('torn-tail: shard has 9 lines (2 + fragment + 5 + checkpoint)',
              lines.length === 9, `got ${lines.length}`);

        const frag = lines[2] ?? new Uint8Array(0);
        check('torn-tail: buried fragment is unparseable (dead line)',
              frag.length > 0 && tryParse(frag) === null,
              `fragment: ${Buffer.from(frag).toString('utf-8').slice(0, 40)}…`);

        // Chain verifies across the dead line (chain covers it; lastSeq ignores it).
        const v = await verifyChain(adapter, SHARD, ORIGIN);
        check('torn-tail: chain verifies after burial', v.valid, v.detail);

        // Coverage: last_seq == max DATA seq (7 = seqs 1,2 + 3..7).
        const cpIdx = findCheckpoint(lines);
        check('torn-tail: checkpoint located', cpIdx >= 0, `idx ${cpIdx}`);
        if (cpIdx >= 0) {
            const cp = tryParse(lines[cpIdx])!;
            check('torn-tail: coverage invariant — last_seq matches data max',
                  cp.last_seq === 7, JSON.stringify({ last_seq: cp.last_seq, expected: 7 }));
        }
}

// --- Scenario 2: buffer at checkpoint boundary (Tier-2) ---------------------

async function scenarioBufferAtCheckpointBoundary(): Promise<void> {
    console.log('\n=== F11 deepening scenario: buffer at checkpoint boundary ===');
    const fs = new FakeFileSystem();
    // Auto-checkpoint disabled: interval far above the 54 appends.
    const ctx = newCtx(fs, { checkpointInterval: 1000 });
    const SHARD = shardPath(ROOT, ORIGIN);

    // 54 Tier-2 events — below the 64 flush threshold, so they stay buffered.
    await appendTier2Chunks(ctx, 'buf', BUFFER_COUNT - 10);

    // Manual checkpoint: drains the buffer, then digests what is on disk.
    await ctx.log.checkpoint();
    await ctx.log.dispose();

    const raw = fs.getBytes(SHARD)!;
    check('buffer-at-boundary: checkpoint emitted',
          countSubstring(raw, '"type":"log.checkpoint"') >= 1);

    const chunkCount = countSubstring(raw, '"type":"chunk.indexed"');
    check('buffer-at-boundary: all 54 Tier-2 events persisted',
          chunkCount === BUFFER_COUNT - 10, `got ${chunkCount}`);

    const v = await verifyChain(new FakeAdapter(fs, ROOT), SHARD, ORIGIN);
    check('buffer-at-boundary: chain verifies with flushed buffer', v.valid, v.detail);

    const lines = splitByteLines(raw);
    const cpIdx = findCheckpoint(lines);
    if (cpIdx >= 0) {
        const cp = tryParse(lines[cpIdx])!;
        check('buffer-at-boundary: checkpoint covers buffered events',
              cp.last_seq === 54, `last_seq=${cp.last_seq}, expected 54`);
    }
}

// --- Scenario 3: back-to-back checkpoints, zero data between — PROBE --------

async function scenarioConsecutiveCheckpoints(): Promise<void> {
    console.log('\n=== F11 deepening scenario: back-to-back checkpoints (PROBE) ===');
    const fs = new FakeFileSystem();
    const ctx = newCtx(fs, { checkpointInterval: 1000 }); // no auto-checkpoint
    const SHARD = shardPath(ROOT, ORIGIN);

    await appendTier1Notes(ctx, 'consec', 5);  // seqs 1..5

    await ctx.log.checkpoint();                 // cp #1 → seq 6, last_seq 5
    await ctx.log.checkpoint();                 // cp #2 → seq 7, last_seq ?
    await ctx.log.dispose();

    const raw = fs.getBytes(SHARD)!;
    const lines = splitByteLines(raw);

    const cps = lines
    .map((l) => tryParse(l))
    .filter((o): o is Record<string, unknown> => o !== null && o.type === 'log.checkpoint');

    check('consecutive: two checkpoints present', cps.length === 2, `got ${cps.length}`);
    if (cps.length === 2) {
        check('consecutive: cp1 claims last_seq 5',
              cps[0].last_seq === 5, `got ${cps[0].last_seq}`);
        // CORRECT behaviour: no data between, so cp2 must also claim 5.
        // A failure here is the probe firing (computeChain counts cp1's seq).
        check('consecutive: cp2 claims last_seq 5 (no data between)',
              cps[1].last_seq === 5, `got ${cps[1].last_seq}`);
    }

    const v = await verifyChain(new FakeAdapter(fs, ROOT), SHARD, ORIGIN);
    check('consecutive: chain verifies across back-to-back checkpoints',
          v.valid, v.detail);
}

// --- Scenario 4: intermediate chain segment assertion ----------------------

async function scenarioIntermediateChainSegment(): Promise<void> {
    console.log('\n=== F11 deepening scenario: intermediate chain segment ===');
    const fs = new FakeFileSystem();
    const ctx = newCtx(fs);
    const SHARD = shardPath(ROOT, ORIGIN);

    await appendTier1Notes(ctx, 'inter', 5);
    await ctx.log.dispose();

    const raw = fs.getBytes(SHARD)!;
    const lines = splitByteLines(raw);

    // Independent recomputation of the chain over the first 3 lines.
    const partialBytes = joinByteLines(lines.slice(0, 3));
    const { chain: expectedChain } = computeChain(partialBytes, ORIGIN);
    const genesis = genesisDigest(ORIGIN);
    check('intermediate: chain over first 3 lines differs from genesis',
          expectedChain !== genesis);

    // End-to-end: the full chain still verifies.
    const v = await verifyChain(new FakeAdapter(fs, ROOT), SHARD, ORIGIN);
    check('intermediate: full chain verifies', v.valid, v.detail);

    // OWED: writer-side instrumentation exposing chain state at line N, so the
    // intermediate value can be asserted against an in-flight walk rather than
    // a post-hoc recomputation. Tracked, not silently dropped.
}

// --- Scenario 5: checkpoint rollback on write failure ----------------------

async function scenarioCheckpointRollback(): Promise<void> {
    console.log('\n=== F11 deepening scenario: checkpoint rollback ===');
    const fs = new FakeFileSystem();
    const ctx = newCtx(fs);
    const SHARD = shardPath(ROOT, ORIGIN);

    await appendTier1Notes(ctx, 'rollback', 5);
    const seqBeforeDispose = ctx.log.lastSeq;

    // Inject failure at the ADAPTER's append — the async seam eventlog awaits.
    const originalAppend = ctx.adapter.append.bind(ctx.adapter);
    ctx.adapter.append = async (path: string, data: string): Promise<void> => {
        if (data.includes('"type":"log.checkpoint"')) {
            throw new Error('Injected checkpoint failure');
        }
        return originalAppend(path, data);
    };

    try {
        await ctx.log.dispose();
        check('rollback: dispose threw on checkpoint failure', false,
              'expected error not thrown');
    } catch {
        check('checkpoint rollback: dispose threw on failure', true);
        check('checkpoint rollback: seq rolled back',
              ctx.log.lastSeq <= seqBeforeDispose,
              `seqBefore=${seqBeforeDispose}, seqAfter=${ctx.log.lastSeq}`);
    }

    const raw = fs.getBytes(SHARD)!;
    check('checkpoint rollback: no partial checkpoint in shard',
          countSubstring(raw, '"type":"log.checkpoint"') === 0);
}

// --- Main ------------------------------------------------------------------

async function main(): Promise<void> {
    await scenarioTornTailCheckpoint();
    await scenarioBufferAtCheckpointBoundary();
    await scenarioConsecutiveCheckpoints();
    await scenarioIntermediateChainSegment();
    await scenarioCheckpointRollback();
    console.log('');
    if (failures === 0) {
        console.log('F11-deepening: ALL GREEN (torn-tail + buffer + consecutive + intermediate + rollback)');
    } else {
        console.log(`F11-deepening: ${failures} RED`);
    }
}

main().then(() => process.exit(failures === 0 ? 0 : 1));
