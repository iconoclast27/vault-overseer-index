// =============================================================================
// Vault Overseer — Fixture F02: Sequence gap — FINAL (v1 fixture candidate)
// vault-overseer-index/src/fixtures/f02.ts
//
// Threat: dropped sync line; truncated transfer; hand-edited shard.
//
// Setup: 100 valid events hand-crafted on disk via validLine(), then
// whole-line excision / seq mutation — byte-clean corruption, so we
// test gap detection, not F01's torn-tail path.
//
// Variants (all hard-asserted):
//   A-single   — delete line 57            → gap (57, 58), yield 1–56
//   A-wide     — delete lines 57–60        → gap (57, 61), yield 1–56
//   B-mutant   — line 57's seq → 58        → gap (57, 58), yield 1–56
//   C-two-gaps — delete lines 57 and 81    → halt at FIRST gap (57, 58)
//                  (second hole never inspected; deleted via two-pass
//                   filter — orig line 81 is index 79 after line 57's
//                   removal. Awaiting-builder never reaches it.)
//   C-head     — delete line 1             → gap (1, 2), yield ZERO events
//   C-regress  — line 57's seq → 55        → gap (57, 55): backwards
//                  duplicate caught by the same inequality check
//   C-tail     — delete line 100           → DELIBERATE SILENCE, locked in
//                  (see below)
//
// Pass requires (corpus):
//   1. Scan yields the contiguous prefix and stops
//   2. Report names (origin, expected_seq, got_seq)
//   3. log.integrity emitted naming the gap (expected/got pair IS the
//      bounds — ruled sufficient 2026-10-21)
//   4. Never skips / never pads / never fabricates — bytes unchanged
//   5. Repair path — SKIPPED, owed to F03's heal-scan machinery
//
// C-TAIL DESIGN RULING (2026-10-21): a terminal gap is structurally
// undetectable at scan level — no successor line exists to witness the
// hole. Fabricating an expected event count would violate never-fabricate.
// Witness duty belongs to log.checkpoint digests (schema integrity
// clause 3), not yet built. This fixture therefore ASSERTS THE SILENCE:
// gaps: [], integrity: []. If a future reader change makes the scan
// "detect" terminal gaps, this goes red and demands justification.
//
// Known corollary risk (tracked, not fixed here): post-terminal-drop,
// startupChecks() primes initialSeq at 99 and the next append REISSUES
// seq 100 with different content. Invisible until checkpoints exist.
// Checkpoint machinery = early queue item (F11 candidate).
//
// Run:  node src/fixtures/f02.ts
// =============================================================================

import { FakeFileSystem, FakeAdapter, shardPath, validLine } from '../test-harness.ts';
import { mergeScan, startupChecks } from '../eventlog/reader.ts';
import { EventLog } from '../eventlog/eventlog.ts';
import { healScan } from '../eventlog/heal.ts';

const ROOT = '/f02';
const DIR = '_vault-index/events';
const ORIGIN = 'mokka';

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
    if (ok) {
        console.log(`[PASS] ${name}`);
    } else {
        failures++;
        console.log(`[FAIL] ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
    }
}

// --- Byte-level helpers (candidates for harness export; F03–F06 will want them)

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
    let total = 0;
    for (const l of lines) total += l.length + 1;
    const out = new Uint8Array(total);
    let off = 0;
    for (const l of lines) {
        out.set(l, off);
        out[off + l.length] = 0x0a;
        off += l.length + 1;
    }
    return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function countSubstring(raw: Uint8Array, needle: string): number {
    return Buffer.from(raw).toString('utf-8').split(needle).length - 1;
}

/** Rewrite one line's seq field; envelope key order preserved (in-place assignment). */
function withSeq(lines: Uint8Array[], index: number, seq: number): Uint8Array[] {
    const copy = [...lines];
    const obj = JSON.parse(new TextDecoder().decode(copy[index]));
    obj.seq = seq;
    copy[index] = new TextEncoder().encode(JSON.stringify(obj));
    return copy;
}

// --- Clean shard: 100 hand-crafted events, corpus rule 2 ----------------------

function writeCleanShard(fs: FakeFileSystem): string {
    const lines: string[] = [];
    for (let i = 1; i <= 100; i++) {
        lines.push(validLine(i, 'note.modified', {
            path: `Notes/f02-${String(i).padStart(3, '0')}.md`,
                             mtime: 1763000000000 + i,
                             bytes: 500,
                             content_sha: (i * 0x1111111111111111 % 2 ** 64).toString(16).padStart(16, '0'),
        }));
    }
    const SHARD = shardPath(ROOT, ORIGIN);
    fs.write(SHARD, lines.join(''));
    return SHARD;
}

interface VariantSpec {
    name: string;
    corrupt: (lines: Uint8Array[]) => Uint8Array[];
    /** Events the scan must yield (contiguous prefix from seq 1). */
    expectYielded: number;
    /** Expected gap report: (expected_seq, got_seq). Null = assert SILENCE (C-tail). */
    expectExpected: number | null;
    expectGot: number | null;
}

async function runVariant(spec: VariantSpec): Promise<void> {
    console.log(`\n=== F02 variant: ${spec.name} ===`);
    const fs = new FakeFileSystem();
    const adapter = new FakeAdapter(fs, ROOT);
    const SHARD = writeCleanShard(fs);

    // Precondition: clean shard scans green, or all reds below are
    // attributable to the builder, not the corruption.
    const pre = await mergeScan(adapter, DIR);
    check(`${spec.name} precondition: clean shard yields 100 events`,
          pre.events.length === 100, `got: ${pre.events.length}`);
    check(`${spec.name} precondition: clean shard has no gaps`,
          pre.gaps.length === 0, JSON.stringify(pre.gaps));

    // Corruption: byte-level split on 0x0A BEFORE decode, whole-line
    // excision with terminators — gap detection, not torn-tail.
    const raw = fs.getBytes(SHARD)!;
    const lines = splitByteLines(raw);
    check(`${spec.name}: shard split into 100 byte-lines`,
          lines.length === 100, `got: ${lines.length}`);
    fs.write(SHARD, joinByteLines(spec.corrupt(lines)));

    const bytesBefore = fs.getBytes(SHARD)!;
    const scan = await mergeScan(adapter, DIR);

    // Compact diagnostic (full report shapes already banked 2026-10-21).
    console.log(`[${spec.name}] yielded ${scan.events.length}; ` +
    `gaps: ${JSON.stringify(scan.gaps)}; ` +
    `integrity: ${scan.integrity.length} report(s)`);

    // (1) Contiguous prefix, then stop.
    check(`${spec.name}: scan yields exactly ${spec.expectYielded} events`,
          scan.events.length === spec.expectYielded, `got: ${scan.events.length}`);
    if (spec.expectYielded > 0) {
        check(`${spec.name}: yielded prefix is contiguous 1..${spec.expectYielded}`,
              scan.events.every((e, i) => e.seq === i + 1));
    } else {
        check(`${spec.name}: zero events yielded, as expected`,
              scan.events.length === 0);
    }

    if (spec.expectExpected === null) {
        // C-tail: LOCK IN THE SILENCE. Terminal gap is witness-less at
        // scan level by design (2026-10-21 ruling); checkpoint digests
        // own this detection class. If this assertion ever goes red,
        // the reader started fabricating — justify or revert.
        check(`${spec.name}: terminal gap is SILENT at scan level (by design)`,
              scan.gaps.length === 0 && scan.integrity.length === 0,
              `gaps: ${JSON.stringify(scan.gaps)}, ` +
              `integrity: ${JSON.stringify(scan.integrity)}`);
    } else {
        // (2) Report names (origin, expected_seq, got_seq) — field equality.
        const gap = scan.gaps[0];
        check(`${spec.name}: exactly one gap reported (halt at first)`,
              scan.gaps.length === 1, JSON.stringify(scan.gaps));
        check(`${spec.name}: gap report names origin`,
              gap?.origin === ORIGIN, JSON.stringify(gap));
        check(`${spec.name}: gap report expected_seq ${spec.expectExpected}`,
              gap?.expected_seq === spec.expectExpected, JSON.stringify(gap));
        check(`${spec.name}: gap report got_seq ${spec.expectGot}`,
              gap?.got_seq === spec.expectGot, JSON.stringify(gap));

        // (3) log.integrity names the gap via the expected/got pair.
        const detail = scan.integrity[0]?.detail ?? '';
        check(`${spec.name}: log.integrity names expected ${spec.expectExpected}`,
              detail.includes(`expected_seq: ${spec.expectExpected}`), detail);
        check(`${spec.name}: log.integrity names got ${spec.expectGot}`,
              detail.includes(`got_seq: ${spec.expectGot}`), detail);
    }

    // (4) Never pads, never fabricates — read-only scan, proven bytewise.
    const bytesAfter = fs.getBytes(SHARD)!;
    check(`${spec.name}: mergeScan() rewrote nothing`,
          bytesEqual(bytesBefore, bytesAfter));

    // (5) Repair path — REAL ASSERTION (flipped 2026-10-21; F03's heal scan
    //     IS the repair path — single implementation, not two).
    //
    //     Design finding: clause 5 as originally written ("re-derives tier-2
    //     lines from mtime+sha") describes an operation that cannot exist.
    //     mergeScan() halts at a gap regardless of tier, so healScan() never
    //     sees past one; re-deriving against an incomplete fact record would
    //     fabricate a projection that merely LOOKS whole. Correct behaviour
    //     on a gapped spine: REFUSE, disclose, leave the hole. Re-derivation
    //     after loss is F03's regime; refusal is this one.
    const expectedSeq = spec.expectExpected;
    if (expectedSeq === null) {
        console.log(`[NOTE] F02-repair (${spec.name}): no gap — terminal gap is ` +
        `checkpoint-digest territory, not scan-level repair`);
    } else {
        const su = await startupChecks(adapter, ORIGIN, DIR);
        const log = new EventLog({
            adapter,
            origin: ORIGIN,
            initialSeq: su.recoveredThroughSeq,
            now: () => '2026-10-20T21:04:11+01:00',
        });
        const heal = await healScan(log, adapter, DIR);
        check(`${spec.name}: repair path REFUSES the gapped spine`,
              heal.refused === true, `refused=${heal.refused}`);
        check(`${spec.name}: repair path fabricates nothing`,
              heal.chunksReemitted === 0, `got ${heal.chunksReemitted}`);
        await log.dispose();

        const rawPost = fs.getBytes(SHARD)!;
        check(`${spec.name}: refusal logged to the shard, naming the gap`,
              countSubstring(rawPost, 'heal refused') >= 1 &&
              countSubstring(rawPost, `expected_seq: ${expectedSeq}`) >= 1);

        const postScan = await mergeScan(adapter, DIR);
        check(`${spec.name}: gap SURVIVES the repair attempt (hole not erased)`,
              postScan.gaps.length === 1 &&
              postScan.gaps[0].expected_seq === expectedSeq,
              JSON.stringify(postScan.gaps));
    }
}

// --- Main ----------------------------------------------------------------------

async function main(): Promise<void> {
    const drop = (from: number, to = from) =>
    (lines: Uint8Array[]) => lines.filter((_, i) => i + 1 < from || i + 1 > to);

    const specs: VariantSpec[] = [
        // Primary trio (corpus).
        { name: 'A-single', corrupt: drop(57),
            expectYielded: 56, expectExpected: 57, expectGot: 58 },
            { name: 'A-wide', corrupt: drop(57, 60),
                expectYielded: 56, expectExpected: 57, expectGot: 61 },
                { name: 'B-mutant', corrupt: (l) => withSeq(l, 56, 58),
                    expectYielded: 56, expectExpected: 57, expectGot: 58 },

                    // Escalation tier (2026-10-21): promoted to hard assertions after
                    // report shapes were banked empirically. C-tail asserts its own
                    // silence — see the design ruling in the header.
                    { name: 'C-two-gaps',
                        // Orig line 57 (index 56) removed first; orig line 81 then sits
                        // at index 79 in the filtered array. Halt at gap 1 means the
                        // second hole is never inspected — asserted via yielded count.
                        corrupt: (l) => l.filter((_, i) => i !== 56 && i !== 79),
                        expectYielded: 56, expectExpected: 57, expectGot: 58 },
                        { name: 'C-head', corrupt: drop(1),
                            expectYielded: 0, expectExpected: 1, expectGot: 2 },
                            { name: 'C-regress', corrupt: (l) => withSeq(l, 56, 55),
                                expectYielded: 56, expectExpected: 57, expectGot: 55 },
                                { name: 'C-tail', corrupt: drop(100),
                                    expectYielded: 99, expectExpected: null, expectGot: null },
    ];

    for (const spec of specs) await runVariant(spec);

    console.log('');
    if (failures === 0) {
        console.log('F02: ALL GREEN (7 variants: 3 primary, 4 escalation; ' +
        'C-tail silence locked in as designed)');
    } else {
        console.log(`F02: ${failures} RED`);
    }
}

main().then(() => process.exit(failures === 0 ? 0 : 1));
