// =============================================================================
// Vault Overseer — Fixture F01: Torn tail line
// vault-overseer-index/src/fixtures/f01.ts
//
// Threat: process death mid-append(); fsync lies; power loss on Latitude.
//
// Setup: mokka.jsonl with 50 valid events, then the first ~140 bytes of a
// would-be 51st event — NO trailing newline, cut MID-UTF-8-CHARACTER
// (mandatory per the corpus amendment).
//
// Procedure: startupChecks() → mergeScan() on the damaged shard →
// construct the writer primed from the startup result → resume appending.
//
// Pass requires:
//   1. Reader consumes events 1–50 cleanly
//   2. Torn tail reported via log.integrity: origin, byte length,
//      recovered-through seq
//   3. Non-destructive: torn bytes stay on disk untouched (no truncation)
//   4. The next appendEvent() succeeds, seq resumes at 51, contiguity
//      intact
//
// Fail smells: silent truncation; startup refuses to boot; append blocked.
//
// Run:  node src/fixtures/f01.ts
// =============================================================================

import { FakeFileSystem, FakeAdapter, shardPath, shardWithTornTail } from '../test-harness.ts';
import { EventLog } from '../eventlog/eventlog.ts';
import { startupChecks, mergeScan } from '../eventlog/reader.ts';

const ROOT = '/f01';
const DIR = '_vault-index/events';
const ORIGIN = 'mokka';
const FIXED_TS = '2026-10-20T21:04:11+01:00';

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
    if (ok) {
        console.log(`[PASS] ${name}`);
    } else {
        failures++;
        console.log(`[FAIL] ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
    }
}

async function main(): Promise<void> {
    // --- Setup: hostile shard -------------------------------------------------
    const fs = new FakeFileSystem();
    const adapter = new FakeAdapter(fs, ROOT);
    fs.write(shardPath(ROOT, ORIGIN), shardWithTornTail(50, 140));
    const SHARD = shardPath(ROOT, ORIGIN);

    const originalBytes = fs.getBytes(SHARD)!;
    const originalLength = originalBytes.length;

    // --- Procedure step 1: startupChecks() -------------------------------------
    const startup = await startupChecks(adapter, ORIGIN, DIR);

    check('shard detected as existing', startup.shardExists);
    check('torn tail detected', startup.tornTail);
    check('no false foreign-origin alarm', !startup.foreignOrigin);
    check('recovered through seq 50', startup.recoveredThroughSeq === 50,
          `got: ${startup.recoveredThroughSeq}`);
    check('startup report names origin',
          startup.integrity.some((r) => r.detail.includes('origin: mokka')));
    check('startup report names byte length',
          startup.integrity.some((r) => r.detail.includes('bytes:')));
    check('startup report names recovered-through',
          startup.integrity.some((r) => r.detail.includes('recovered_through: 50')));

    // --- Procedure step 2: mergeScan() on the damaged shard --------------------
    const scan1 = await mergeScan(adapter, DIR);

    check('damaged scan yields events 1–50', scan1.events.length === 50,
          `got: ${scan1.events.length}`);
    check('damaged scan has no gaps', scan1.gaps.length === 0,
          JSON.stringify(scan1.gaps));
    check('damaged scan reports the torn tail', scan1.integrity.length >= 1,
          JSON.stringify(scan1.integrity));
    check('scan 1 seq contiguity 1..50',
          scan1.events.every((e, i) => e.seq === i + 1));

    // --- Procedure step 3: writer primed from startup, resume ------------------
    const log = new EventLog({
        adapter,
        origin: ORIGIN,
        initialSeq: startup.recoveredThroughSeq,
        now: () => FIXED_TS,
                             hasTornTail: startup.tornTail,
    });

    // The torn-tail report must LAND in the log, not just stdout.
    await log.reportIntegrity(
        startup.integrity.map((r) => r.detail).join('; '),
    );

    // --- Non-destructive check AFTER writes: prefix intact ----------------------
    await log.appendEvent('user', 'note.created', {
        path: 'Notes/post-crash.md',
        mtime: 1763000900000,
        bytes: 200,
        content_sha: 'cccccccccccccccc',
    });

    const nowBytes = fs.getBytes(SHARD)!;
    check('original bytes untouched (no truncation/rewrite)',
          nowBytes.length > originalLength &&
          Buffer.from(nowBytes.subarray(0, originalLength)).equals(originalBytes),
          `was ${originalLength} bytes, now ${nowBytes.length}`);
    check('write began with a newline separator (dead line burial)',
          nowBytes[originalLength] === 0x0a,
          `byte at ${originalLength}: ${nowBytes[originalLength]}`);

    // --- Procedure step 4: resumed shard scans clean ----------------------------
    const scan2 = await mergeScan(adapter, DIR);

    check('post-recovery scan: 52 events (50 + integrity + new)',
          scan2.events.length === 52, `got: ${scan2.events.length}`);
    check('resume: first new event is log.integrity with seq 51',
          scan2.events[50].type === 'log.integrity' && scan2.events[50].seq === 51,
          `got: ${scan2.events[50]?.type} seq ${scan2.events[50]?.seq}`);
    check('resume: appended event carries seq 52',
          scan2.events[51].seq === 52 && scan2.events[51].type === 'note.created',
          `got: ${scan2.events[51]?.type} seq ${scan2.events[51]?.seq}`);
    check('post-recovery scan: no gaps', scan2.gaps.length === 0,
          JSON.stringify(scan2.gaps));
    check('dead line reported loudly, not silently skipped',
          scan2.integrity.some((r) => r.detail.includes('unreadable line')),
          JSON.stringify(scan2.integrity));
    check('writer still usable (subsequent append succeeds)',
          log.lastSeq === 52, `lastSeq: ${log.lastSeq}`);

    // --- Summary ----------------------------------------------------------------
    console.log('');
    if (failures === 0) {
        console.log('F01: ALL GREEN');
    } else {
        console.log(`F01: ${failures} RED`);
    }
}

main().then(() => process.exit(failures === 0 ? 0 : 1));
