// =============================================================================
// Vault Overseer — Smoke Test (writer shakedown)
// vault-overseer-index/src/smoke.ts
//
// Exercises appendEvent() against the FakeAdapter harness:
//   Tier-1 write-through, Tier-2 buffering, buffer-carry on Tier-1 writes,
//   farewell flush on dispose(), envelope key order, seq contiguity,
//   '\n' termination, frozen-clock determinism.
//
// NOT the fixture corpus. F01 comes after startupChecks()/mergeScan()
// exist. This is the first flame under the writer.
//
// Run:  node src/smoke.ts     (from the vault-overseer-index folder)
// Exit: 0 = all green, 1 = at least one red
// =============================================================================

import { spawnContext, shardPath } from './test-harness.ts';

const FIXED_TS = '2026-10-20T21:04:11+01:00';
const ROOT = '/smoke';
const SHARD = shardPath(ROOT, 'mokka');

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
    if (ok) {
        console.log(`[PASS] ${name}`);
    } else {
        failures++;
        console.log(`[FAIL] ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
    }
}

function toLines(text: string): string[] {
    return text.split('\n').filter((l) => l.length > 0);
}

async function main(): Promise<void> {
    const { log, fs } = spawnContext('mokka', ROOT, {
        now: () => FIXED_TS,
    });

    // --- Tier 1: write-through ----------------------------------------------
    await log.appendEvent('user', 'note.created', {
        path: 'Notes/first.md',
        mtime: 1763000000000,
        bytes: 120,
        content_sha: 'aaaaaaaaaaaaaaaa',
    });

    const afterTier1 = fs.read(SHARD);
    check('tier 1 written immediately', afterTier1 !== undefined && toLines(afterTier1).length === 1,
          `lines on disk: ${afterTier1 === undefined ? 'no shard' : toLines(afterTier1).length}`);

    // --- Tier 2: buffered ----------------------------------------------------
    await log.appendEvent('plugin', 'chunk.indexed', {
        path: 'Notes/first.md', ord: 0, bs: 0, be: 512, vh: '9f86d081884c7d65', cp: 1,
    });
    await log.appendEvent('plugin', 'chunk.indexed', {
        path: 'Notes/first.md', ord: 1, bs: 512, be: 900, vh: '9f86d081884c7d66', cp: 1,
    });

    check('tier 2 buffered (pending=2)', log.pendingCount === 2, `pending: ${log.pendingCount}`);
    check('tier 2 not flushed early by count',
          toLines(fs.read(SHARD) ?? '').length === 1);

    // --- Tier 1 carries the buffer -------------------------------------------
    await log.appendEvent('user', 'note.modified', {
        path: 'Notes/first.md',
        mtime: 1763000009000,
        bytes: 135,
        content_sha: 'bbbbbbbbbbbbbbbb',
    });

    const carried = toLines(fs.read(SHARD) ?? '');
    check('tier 1 carries buffered tier 2 (4 lines)', carried.length === 4,
          `lines: ${carried.length}`);
    check('buffer drained', log.pendingCount === 0, `pending: ${log.pendingCount}`);

    // --- Farewell flush ------------------------------------------------------
    await log.appendEvent('plugin', 'chunk.evicted', {
        vh: '9f86d081884c7d66', path: 'Notes/first.md',
    });
    check('evict still buffered', log.pendingCount === 1, `pending: ${log.pendingCount}`);

    await log.dispose();
    const finalText = fs.read(SHARD) ?? '';
    const lines = toLines(finalText);
    check('dispose flushes buffer (5 lines)', lines.length === 5, `lines: ${lines.length}`);

    // --- Envelope inspection -------------------------------------------------
    const events = lines.map((l) => JSON.parse(l));

    check('seq contiguous 1..5',
          events.every((e, i) => e.seq === i + 1),
          `seqs: ${events.map((e) => e.seq).join(',')}`);

    check('every line ends with \\n (bytes)',
          (() => {
              const bytes = fs.getBytes(SHARD);
              return bytes !== undefined && bytes[bytes.length - 1] === 0x0a;
          })());

    check('envelope key order normative',
          events.every((e) =>
          ['v', 'seq', 'ts', 'origin', 'actor', 'type'].every((k, i) => Object.keys(e)[i] === k)));

    check('payload key order: note.created/modified',
          JSON.stringify(Object.keys(events[0])) === JSON.stringify(['v', 'seq', 'ts', 'origin', 'actor', 'type', 'path', 'mtime', 'bytes', 'content_sha']) &&
          JSON.stringify(Object.keys(events[3])) === JSON.stringify(['v', 'seq', 'ts', 'origin', 'actor', 'type', 'path', 'mtime', 'bytes', 'content_sha']));

    check('payload key order: chunk.indexed',
          JSON.stringify(Object.keys(events[1])) === JSON.stringify(['v', 'seq', 'ts', 'origin', 'actor', 'type', 'path', 'ord', 'bs', 'be', 'vh', 'cp']));

    check('payload key order: chunk.evicted',
          JSON.stringify(Object.keys(events[4])) === JSON.stringify(['v', 'seq', 'ts', 'origin', 'actor', 'type', 'vh', 'path']));

    check('disk order == seq order (tier 2 carried ahead of tier 1)',
          events[1].type === 'chunk.indexed' && events[2].type === 'chunk.indexed' && events[3].type === 'note.modified');

    check('ts from frozen clock', events.every((e) => e.ts === FIXED_TS));
    check('origin stamped mokka', events.every((e) => e.origin === 'mokka'));
    check('actors correct', events.filter((e) => e.type.startsWith('chunk')).every((e) => e.actor === 'plugin'));

    // --- Summary -------------------------------------------------------------
    console.log('');
    if (failures === 0) {
        console.log('SMOKE TEST: all green. The writer breathes.');
    } else {
        console.log(`SMOKE TEST: ${failures} red — the writer coughs.`);
    }
}

main().then(() => process.exit(failures === 0 ? 0 : 1));
