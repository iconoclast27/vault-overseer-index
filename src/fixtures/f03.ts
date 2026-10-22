// =============================================================================
// Vault Overseer — Fixture F03: Mid-flush crash with live buffer
// vault-overseer-index/src/fixtures/f03.ts
// Generated: 2026-10-22T11:35:00+01:00
//
// Threat: Tier-2 buffer part-full at process death — the failure mode
// the two-tier design PREDICTS, so it is tested harder than the
// unpredictable ones (corpus doctrine).
//
// Scenarios:
//   canonical   — 3 Tier-1 note.created (write-through) THEN 40 Tier-2
//                 chunk.indexed (buffered), kill WITHOUT dispose().
//                 Ordering is load-bearing: Tier-1 first ⇒ facts are
//                 durable, the 40 chunk events are genuinely lost.
//                 Fresh context: startupChecks → healScan → dispose →
//                 heal AGAIN (idempotence) → P1 verification.
//   reversed    — 40 Tier-2 first, THEN 3 Tier-1: buffer-carry drags
//                 everything to disk; the "crash" loses nothing. Heals
//                 ZERO (all 40 vh collide). This is the vacuity guard:
//                 a canonical-scenario pass would be vacuous here, and
//                 this variant documents WHY.
//   gap-refusal — post-crash shard hand-corrupted with a seq gap:
//                 healScan must REFUSE loudly (never-fabricate), emit
//                 nothing, log.integrity names the gap.
//
// Pass requires (corpus F03):
//   1. Tier-1 facts present exactly once — facts survived, full stop
//   2. The 40 Tier-2 events absent from disk at kill time
//   3. Heal re-derives all 40, field-identical to the lost events
//      (deterministic stub ⇒ provable equality)
//   4. Heal logs itself: "buffer window lost, N events re-derived"
//   5. Idempotence: second heal dedupes all 40 vh, emits zero
//   6. P1: re-derived offsets reproduce their text (slice == vh)
//   7. Clean crash: no torn tail, seq contiguous, gaps: []
//
// The killed context's idle timer stays armed — spawned with a
// geological tier2IdleMs (a Zone 3 tunable, so corpus rule 2 holds:
// hostile FILES, no internal mocks). Determinism rule 4.
//
// Fillers are ASCII (byte arithmetic must be exact: 64-byte lines,
// 8 per 512-byte chunk). UTF-8 hostility is F01/F02's jurisdiction.
//
// Run:  node ./src/fixtures/f03.ts
// =============================================================================

import { FakeFileSystem, FakeAdapter, spawnContext, shardPath } from '../test-harness.ts';
import { startupChecks, mergeScan } from '../eventlog/reader.ts';
import { healScan } from '../eventlog/heal.ts';
import { chunkStub, contentSha, sha16 } from '../chunker/stub.ts';
import { renderEmbedInput, embedVh } from '../chunker/render.ts';

const ROOT = '/f03';
const DIR = '_vault-index/events';
const ORIGIN = 'mokka';
const FIXED_TS = '2026-10-21T12:00:00+01:00';
const GEOLOGICAL_IDLE_MS = 3_600_000;

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
    if (ok) {
        console.log(`[PASS] ${name}`);
    } else {
        failures++;
        console.log(`[FAIL] ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
    }
}

// --- Helpers -------------------------------------------------------------------

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

function parseEvents(raw: Uint8Array, type: string): Record<string, unknown>[] {
    return splitByteLines(raw)
    .map((l) => JSON.parse(Buffer.from(l).toString('utf-8')) as Record<string, unknown>)
    .filter((e) => e.type === type);
}

function countSubstring(raw: Uint8Array, needle: string): number {
    return Buffer.from(raw).toString('utf-8').split(needle).length - 1;
}

/** Sorted JSON keys of chunk events — field-equality without seq/ts noise. */
function chunkKeys(raw: Uint8Array): string[] {
    return parseEvents(raw, 'chunk.indexed')
    .map((e) =>
    JSON.stringify({ path: e.path, ord: e.ord, bs: e.bs, be: e.be, vh: e.vh, cp: e.cp }))
    .sort();
}

function expectedChunkKeys(notes: NoteSpec[]): string[] {
    return notes
    .flatMap((n) =>
    chunkStub(n.bytes).map((c) =>
    JSON.stringify({ path: n.path, ord: c.ord, bs: c.bs, be: c.be, vh: c.vh, cp: c.cp })))
    .sort();
}

/** Independent P1 probe — same invariant heal polices, asserted here. */
function p1Failures(raw: Uint8Array, notes: NoteSpec[]): number {
    const byPath = new Map(notes.map((n) => [n.path, n.bytes]));
    let bad = 0;
    for (const e of parseEvents(raw, 'chunk.indexed')) {
        const bytes = byPath.get(String(e.path))!;
        const text = Buffer.from(bytes.subarray(Number(e.bs), Number(e.be))).toString('utf-8');
        // Migration 2026-10-22: render via shared contract (4 args, fm=null)
        const vh = embedVh(renderEmbedInput('search_document:', [], null, text));
        if (vh !== String(e.vh)) bad++;
    }
    return bad;
}

// --- World: 3 notes, deterministic chunk counts (14+13+13 = 40) ---------------

interface NoteSpec { path: string; bytes: Uint8Array; chunkCount: number; }

function noteFiller(lines: number): Uint8Array {
    const line = '='.repeat(63) + '\n'; // exactly 64 bytes
    return Buffer.from(line.repeat(lines), 'utf-8');
}

function buildWorld(chunkCounts: number[]): { fs: FakeFileSystem; notes: NoteSpec[] } {
    const fs = new FakeFileSystem();
    const notes = chunkCounts.map((k, i) => {
        const path = `Notes/f03-${i + 1}.md`;
        return { path, bytes: noteFiller(k * 8), chunkCount: k };
    });
    for (const n of notes) fs.write(`${ROOT}/${n.path}`, n.bytes);
    return { fs, notes };
}

async function appendFacts(ctx: { log: ReturnType<typeof spawnContext>['log'] }, notes: NoteSpec[]): Promise<void> {
    for (const n of notes) {
        await ctx.log.appendEvent('user', 'note.created', {
            path: n.path,
            mtime: 1763000000000,
            bytes: n.bytes.length,
            content_sha: contentSha(n.bytes),
        });
    }
}

async function appendChunks(ctx: { log: ReturnType<typeof spawnContext>['log'] }, notes: NoteSpec[]): Promise<number> {
    let n = 0;
    for (const note of notes) {
        for (const c of chunkStub(note.bytes)) {
            await ctx.log.appendEvent('plugin', 'chunk.indexed', {
                path: note.path, ord: c.ord, bs: c.bs, be: c.be, vh: c.vh, cp: c.cp,
            });
            n++;
        }
    }
    return n;
}

// --- Scenario 1: canonical — Tier-1 first, genuine loss, heal, heal again ----

async function scenarioCanonical(): Promise<void> {
    console.log('\n=== F03 scenario: canonical (Tier-1 first, kill with live buffer) ===');
    const { fs, notes } = buildWorld([14, 13, 13]);
    const SHARD = shardPath(ROOT, ORIGIN);
    const TOTAL = 40;

    // DOOMED CONTEXT: spawns with shared fs, writes Tier-1 then Tier-2, dies
    const doomed = spawnContext(ORIGIN, ROOT, {
        fs, now: () => FIXED_TS, settings: { tier2IdleMs: GEOLOGICAL_IDLE_MS },
    });
    await appendFacts(doomed, notes);
    const appended = await appendChunks(doomed, notes);

    check('canonical: 40 Tier-2 events appended (world arithmetic holds)',
          appended === TOTAL, `got ${appended}`);
    check('canonical: writer holds 40 buffered events at kill time',
          doomed.log.pendingCount === TOTAL, `got ${doomed.log.pendingCount}`);

    // KILL: abandon without dispose(). No farewell flush, ever.
    void doomed;

    const rawAtKill = fs.getBytes(SHARD)!;
    check('canonical: exactly 3 lines on disk at kill time',
          splitByteLines(rawAtKill).length === 3, `got ${splitByteLines(rawAtKill).length}`);
    check('canonical: zero chunk events leaked to disk',
          parseEvents(rawAtKill, 'chunk.indexed').length === 0);
    check('canonical: all 3 Tier-1 facts durable',
          parseEvents(rawAtKill, 'note.created').length === 3);

    // DEBUG: print what the fresh context will see
    console.log(`DEBUG: shard at kill has ${splitByteLines(rawAtKill).length} lines, ${parseEvents(rawAtKill, 'note.created').length} Tier-1 facts`);

    // FRESH CONTEXT: shares the SAME fs, runs startupChecks then heal
    const adapter2 = new FakeAdapter(fs, ROOT);
    const su2 = await startupChecks(adapter2, ORIGIN, DIR);
    const ctx2 = spawnContext(ORIGIN, ROOT, {
        fs,
        now: () => FIXED_TS,
                              initialSeq: su2.recoveredThroughSeq,
                              settings: { tier2IdleMs: GEOLOGICAL_IDLE_MS },
    });

    check('canonical: startup recovers seq 3',
          su2.recoveredThroughSeq === 3, `got ${su2.recoveredThroughSeq}`);
    check('canonical: no torn tail', !su2.tornTail);
    check('canonical: no foreign origin', !su2.foreignOrigin);
    check('canonical: filesystem contains 3 note.created events',
          parseEvents(fs.getBytes(SHARD)!, 'note.created').length === 3);

    const heal1 = await healScan(ctx2.log, adapter2, DIR);
    check('canonical: heal did not refuse', !heal1.refused);
    check('canonical: heal examined 3 paths', heal1.pathsExamined === 3);
    check('canonical: heal re-derived all 40 lost chunks',
          heal1.chunksReemitted === TOTAL, `got ${heal1.chunksReemitted}`);
    check('canonical: zero dedupe hits on first heal',
          heal1.vhDeduped === 0, `got ${heal1.vhDeduped}`);
    check('canonical: zero P1 failures on first heal', heal1.p1Failures === 0);
    await ctx2.log.dispose(); // farewell flush — durability restored
    const rawHealed = fs.getBytes(SHARD)!;
    check('canonical: no "file absent" integrity reports',
          countSubstring(rawHealed, 'file absent') === 0);
    check('canonical: 40 chunk events on disk after heal',
          parseEvents(rawHealed, 'chunk.indexed').length === TOTAL);
    check('canonical: heal logged itself (buffer window lost)',
          countSubstring(rawHealed, 'buffer window lost') >= 1);
    check('canonical: re-derived chunks are field-identical to the lost ones',
          JSON.stringify(chunkKeys(rawHealed)) === JSON.stringify(expectedChunkKeys(notes)));
    check('canonical: P1 holds — offsets reproduce text',
          p1Failures(rawHealed, notes) === 0, `got ${p1Failures(rawHealed, notes)}`);

    // Idempotence: heal AGAIN from a fresh context. Everything must collide.
    const adapter3 = new FakeAdapter(fs, ROOT);
    const su3 = await startupChecks(adapter3, ORIGIN, DIR);
    const ctx3 = spawnContext(ORIGIN, ROOT, {
        fs,
        now: () => FIXED_TS,
                              initialSeq: su3.recoveredThroughSeq,
                              settings: { tier2IdleMs: GEOLOGICAL_IDLE_MS },
    });

    const heal2 = await healScan(ctx3.log, adapter3, DIR);
    check('canonical: second heal re-emits NOTHING',
          heal2.chunksReemitted === 0, `got ${heal2.chunksReemitted}`);
    check('canonical: second heal dedupes all 40 vh',
          heal2.vhDeduped === TOTAL, `got ${heal2.vhDeduped}`);
    check('canonical: second heal still P1-clean', heal2.p1Failures === 0);
    await ctx3.log.dispose();

    const rawFinal = fs.getBytes(SHARD)!;
    check('canonical: still exactly 40 chunk events after second heal',
          parseEvents(rawFinal, 'chunk.indexed').length === TOTAL);
    const finalScan = await mergeScan(new FakeAdapter(fs, ROOT), DIR);
    check('canonical: final scan — no gaps, Tier-1 facts survived exactly once',
          finalScan.gaps.length === 0 &&
          finalScan.events.filter((e) => e.type === 'note.created').length === 3);
}

// --- Scenario 2: reversed order — vacuity guard -------------------------------

async function scenarioReversed(): Promise<void> {
    console.log('\n=== F03 scenario: reversed (Tier-2 first — vacuity guard) ===');
    const { fs, notes } = buildWorld([14, 13, 13]);
    const SHARD = shardPath(ROOT, ORIGIN);

    const ctx = spawnContext(ORIGIN, ROOT, {
        fs, now: () => FIXED_TS, settings: { tier2IdleMs: GEOLOGICAL_IDLE_MS },
    });
    await appendChunks(ctx, notes); // 40 Tier-2 FIRST — buffered
    await appendFacts(ctx, notes);  // Tier-1 write-through CARRIES the buffer
    void ctx;                        // "crash" — but the buffer already fled

    const raw = fs.getBytes(SHARD)!;
    check('reversed: buffer was carried — 43 lines on disk',
          splitByteLines(raw).length === 43, `got ${splitByteLines(raw).length}`);
    check('reversed: crash lost nothing (all 40 chunk events durable)',
          parseEvents(raw, 'chunk.indexed').length === 40);

    // A heal here MUST emit zero: the crash was vacuous, and emitting
    // would be DOUBLE-EMITTING events that never died.
    const adapter = new FakeAdapter(fs, ROOT);
    const su = await startupChecks(adapter, ORIGIN, DIR);
    const f = spawnContext(ORIGIN, ROOT, {
        fs,
        now: () => FIXED_TS,
                           initialSeq: su.recoveredThroughSeq,
                           settings: { tier2IdleMs: GEOLOGICAL_IDLE_MS },
    });
    const heal = await healScan(f.log, adapter, DIR);
    check('reversed: heal re-emits zero (no double-emit)',
          heal.chunksReemitted === 0, `got ${heal.chunksReemitted}`);
    check('reversed: heal dedupes all 40 vh (collision guard)',
          heal.vhDeduped === 40, `got ${heal.vhDeduped}`);
    await f.log.dispose();
    check('reversed: no phantom "buffer window lost" report',
          countSubstring(fs.getBytes(SHARD)!, 'buffer window lost') === 0);
}

// --- Scenario 3: gap refusal — never-fabricate --------------------------------

async function scenarioGapRefusal(): Promise<void> {
    console.log('\n=== F03 scenario: gap refusal (heal across a broken spine) ===');
    const { fs } = buildWorld([14, 13, 13]);
    const SHARD = shardPath(ROOT, ORIGIN);

    const ctx = spawnContext(ORIGIN, ROOT, {
        fs, now: () => FIXED_TS, settings: { tier2IdleMs: GEOLOGICAL_IDLE_MS },
    });
    const notes3 = buildWorld([14, 13, 13]).notes; // facts only; buffer irrelevant
    await appendFacts(ctx, notes3);
    void ctx;

    // Hand-corruption: delete line 2 (seq 2) — byte-clean, F02's lane.
    const raw = fs.getBytes(SHARD)!;
    const lines = splitByteLines(raw);
    const corrupted = lines.filter((_, i) => i !== 1);
    const joined = Buffer.concat(corrupted.map((l) => Buffer.concat([l, Buffer.from('\n')])));
    fs.write(SHARD, joined);

    const adapter = new FakeAdapter(fs, ROOT);
    const su = await startupChecks(adapter, ORIGIN, DIR);
    const f = spawnContext(ORIGIN, ROOT, {
        fs,
        now: () => FIXED_TS,
                           initialSeq: su.recoveredThroughSeq,
                           settings: { tier2IdleMs: GEOLOGICAL_IDLE_MS },
    });
    const heal = await healScan(f.log, adapter, DIR);
    check('gap-refusal: heal REFUSED', heal.refused);
    check('gap-refusal: nothing re-derived across the gap',
          heal.chunksReemitted === 0, `got ${heal.chunksReemitted}`);
    await f.log.dispose();

    const rawAfter = fs.getBytes(SHARD)!;
    check('gap-refusal: refusal logged loudly and names the gap',
          countSubstring(rawAfter, 'heal refused') >= 1 &&
          countSubstring(rawAfter, 'expected_seq: 2') >= 1);
    check('gap-refusal: zero chunk events fabricated',
          parseEvents(rawAfter, 'chunk.indexed').length === 0);
}

// --- Main -----------------------------------------------------------------------

async function main(): Promise<void> {
    await scenarioCanonical();
    await scenarioReversed();
    await scenarioGapRefusal();
    console.log('');
    if (failures === 0) {
        console.log('F03: ALL GREEN (canonical heal + idempotence + reversed-order vacuity guard + gap refusal)');
    } else {
        console.log(`F03: ${failures} RED`);
    }
}

main().then(() => process.exit(failures === 0 ? 0 : 1));
