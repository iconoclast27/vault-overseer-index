// =============================================================================
// Vault Overseer — Fixture F11: Checkpoint verification
// vault-overseer-index/src/fixtures/f11.ts
//
// Earns the checkpoint machinery (four ratified rulings, 2026-10-21):
//   - Shutdown checkpoint on dispose() when events were appended
//   - Threshold auto-checkpoint (checkpointInterval setting)
//   - Coverage invariant: checkpoint's last_seq == preceding data max seq
//   - Tamper + truncation witnessed by the digest chain
//
// Scenarios:
//   1. shutdown — append 3, dispose → checkpoint present, chain verifies
//   2. threshold — cross checkpointInterval mid-stream → auto-checkpoint,
//      chain verifies end-to-end across it
//   3. tamper — mutate a covered line's bytes → digest mismatch, loud
//   4. truncation (C-tail kin) — delete a covered line → digest mismatch
//      (the chain, not the positional check, is this scenario's witness)
//   5. coverage — falsify a checkpoint's last_seq FIELD only: carried
//      digest still matches, preceding chain intact — the POSITIONAL
//      check is the only thing that can catch it
//
// Honest limitation (documented, not hidden): a tail drop that eats the
// checkpoint line itself is cross-machine territory (schema clause 3:
// received-vs-sent); no single-file witness exists for it. F11 asserts
// what is true.
//
// Run: node ./src/fixtures/f11.ts
// =============================================================================

import { FakeFileSystem, FakeAdapter, spawnContext, shardPath } from '../test-harness.ts';
import { verifyChain } from '../eventlog/checkpoint.ts';

const ROOT = '/f11';
const DIR = '_vault-index/events';
const ORIGIN = 'mokka';
const THRESHOLD = 10; // shortened for test speed; production default is 10k

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

function newCtx(fs: FakeFileSystem, initialSeq = 0) {
    return spawnContext(ORIGIN, ROOT, {
        fs,
        now: () => '2026-10-21T13:00:00+01:00',
                        initialSeq,
                        settings: { checkpointInterval: THRESHOLD },
    });
}

async function appendNotes(
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

/** Locate a checkpoint line index in a byte-line array. */
function findCheckpoint(lines: Uint8Array[]): number {
    return lines.findIndex((l) => l.toString().includes('"type":"log.checkpoint"'));
}

// --- Scenario 1: shutdown checkpoint -------------------------------------------

async function scenarioShutdown(): Promise<void> {
    console.log('\n=== F11 scenario: shutdown checkpoint ===');
    const fs = new FakeFileSystem();
    const ctx = newCtx(fs);
    const SHARD = shardPath(ROOT, ORIGIN);

    await appendNotes(ctx, 'f11', 3);

    const before = fs.getBytes(SHARD)!;
    check('shutdown: 3 lines before dispose', splitByteLines(before).length === 3);

    await ctx.log.dispose();

    const after = fs.getBytes(SHARD)!;
    check('shutdown: 4 lines after dispose (checkpoint appended)',
          splitByteLines(after).length === 4,
          `got ${splitByteLines(after).length}`);
    check('shutdown: checkpoint present',
          countSubstring(after, '"type":"log.checkpoint"') === 1);

    // Coverage invariant, structural: checkpoint's seq is last_seq + 1.
    const lines = splitByteLines(after);
    const cp = JSON.parse(lines[findCheckpoint(lines)].toString());
    check('shutdown: coverage invariant — checkpoint seq is last_seq + 1',
          cp.seq === cp.last_seq + 1, JSON.stringify({ seq: cp.seq, last_seq: cp.last_seq }));

    const v = await verifyChain(new FakeAdapter(fs, ROOT), SHARD, ORIGIN);
    check('shutdown: chain verifies cleanly', v.valid, v.detail);
}

// --- Scenario 2: threshold auto-checkpoint -------------------------------------

async function scenarioThreshold(): Promise<void> {
    console.log('\n=== F11 scenario: threshold auto-checkpoint ===');
    const fs = new FakeFileSystem();
    const ctx = newCtx(fs);
    const SHARD = shardPath(ROOT, ORIGIN);

    // THRESHOLD + 5 appends: auto-checkpoint should fire before append #11.
    await appendNotes(ctx, 'thresh', THRESHOLD + 5);
    await ctx.log.dispose();

    const raw = fs.getBytes(SHARD)!;
    const checkpointCount = countSubstring(raw, '"type":"log.checkpoint"');
    check('threshold: auto-checkpoint emitted mid-stream (plus shutdown)',
          checkpointCount >= 2, `got ${checkpointCount}`);
    check('threshold: auto-checkpoint lands at the boundary (seq 11 area)',
          raw.includes('"last_seq":10'), 'expected a checkpoint claiming last_seq 10');

    const v = await verifyChain(new FakeAdapter(fs, ROOT), SHARD, ORIGIN);
    check('threshold: chain verifies across auto-checkpoints', v.valid, v.detail);
}

// --- Scenario 3: tamper — covered byte mutated ---------------------------------

async function scenarioTamper(): Promise<void> {
    console.log('\n=== F11 scenario: tamper under surviving checkpoint ===');
    const fs = new FakeFileSystem();
    const ctx = newCtx(fs);
    const SHARD = shardPath(ROOT, ORIGIN);

    await appendNotes(ctx, 'tamper', 5);
    await ctx.log.dispose(); // checkpoint covers seqs 1..5

    // Mutate a COVERED byte: flip a content_sha hex character in line 2.
    const lines = splitByteLines(fs.getBytes(SHARD)!);
    const mutated = lines[1].toString().replace('e3b0c44219fb0001', 'e3b0c44219fbFFFF');
    check('tamper: precondition — mutation actually changed the line',
          mutated !== lines[1].toString());
    lines[1] = Buffer.from(mutated);
    fs.write(SHARD, joinByteLines(lines));

    const v = await verifyChain(new FakeAdapter(fs, ROOT), SHARD, ORIGIN);
    check('tamper: verification FAILS', !v.valid, v.detail);
    check('tamper: detail names the digest mismatch',
          v.detail !== undefined && v.detail.includes('digest mismatch'), v.detail);
}

// --- Scenario 4: truncation — covered line removed ------------------------------

async function scenarioTruncation(): Promise<void> {
    console.log('\n=== F11 scenario: truncation (covered line removed) ===');
    const fs = new FakeFileSystem();
    const ctx = newCtx(fs);
    const SHARD = shardPath(ROOT, ORIGIN);

    await appendNotes(ctx, 'trunc', 10);
    await ctx.log.checkpoint(); // covers seqs 1..10
    await appendNotes(ctx, 'trunc-post', 5);
    await ctx.log.dispose(); // shutdown checkpoint covers seqs 11..16

    // Delete one covered line (line 7, seq 7). The digest carried by BOTH
    // checkpoints was computed over it — the chain is the witness here.
    const lines = splitByteLines(fs.getBytes(SHARD)!);
    lines.splice(6, 1);
    fs.write(SHARD, joinByteLines(lines));

    const v = await verifyChain(new FakeAdapter(fs, ROOT), SHARD, ORIGIN);
    check('truncation: verification FAILS (chain witnessed the hole)',
          !v.valid, v.detail);
    check('truncation: detail names the mismatch',
          v.detail !== undefined && v.detail.includes('digest mismatch'), v.detail);
}

// --- Scenario 5: coverage — falsified last_seq field ----------------------------

async function scenarioCoverage(): Promise<void> {
    console.log('\n=== F11 scenario: coverage — falsified last_seq field ===');
    const fs = new FakeFileSystem();
    const ctx = newCtx(fs);
    const SHARD = shardPath(ROOT, ORIGIN);

    await appendNotes(ctx, 'cov', 5);
    await ctx.log.dispose(); // checkpoint at seq 6, last_seq 5, digest over 1..5

    // Falsify ONLY the checkpoint's last_seq field: 5 → 7. The carried
    // digest is untouched and still matches the chain over lines 1..5;
    // the preceding data max is 5, not 7 — only the POSITIONAL coverage
    // check can catch this. This is the falsified-ledger attack.
    const lines = splitByteLines(fs.getBytes(SHARD)!);
    const cpIdx = findCheckpoint(lines);
    check('coverage: precondition — checkpoint located', cpIdx >= 0, `idx ${cpIdx}`);
    const falsified = lines[cpIdx].toString().replace('"last_seq":5', '"last_seq":7');
    check('coverage: precondition — falsification actually changed the line',
          falsified !== lines[cpIdx].toString());
    lines[cpIdx] = Buffer.from(falsified);
    fs.write(SHARD, joinByteLines(lines));

    const v = await verifyChain(new FakeAdapter(fs, ROOT), SHARD, ORIGIN);
    check('coverage: verification FAILS (positional witness caught the lie)',
          !v.valid, v.detail);
    check('coverage: detail names the coverage violation',
          v.detail !== undefined && v.detail.includes('coverage violation'), v.detail);
    check('coverage: detail names the vanished-lines direction',
          v.detail !== undefined && v.detail.includes('vanished'), v.detail);
}

// --- Main -----------------------------------------------------------------------

async function main(): Promise<void> {
    await scenarioShutdown();
    await scenarioThreshold();
    await scenarioTamper();
    await scenarioTruncation();
    await scenarioCoverage();
    console.log('');
    if (failures === 0) {
        console.log('F11: ALL GREEN (shutdown + threshold + tamper + truncation + coverage)');
    } else {
        console.log(`F11: ${failures} RED`);
    }
}

main().then(() => process.exit(failures === 0 ? 0 : 1));
