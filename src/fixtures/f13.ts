// =============================================================================
// Vault Overseer — F13: Subscriber seam (live tap on serialized queue)
// src/fixtures/f13.ts
//
// Earns the subscriber seam contract (rev. 2026-10-29, committed in the
// corpus BEFORE this fixture was written — the documented-then-built
// order, per the no-documentation-debt habit):
//
//   S1  Single subscriber receives all event categories (Tier-1,
//       Tier-2, checkpoint); notification fires AFTER disk append —
//       the disk-at-callback witness: when the callback runs, the
//       notified event's OWN line is already on disk.
//   S2  Multiple subscribers receive in FIFO registration order.
//   S3  Unsubscription stops delivery; others unaffected; unsubscribe
//       handle is idempotent (double-call harmless).
//   S4  Subscriber throw logs log.integrity WITH the subscriber's
//       name; the writer continues; the throwing subscriber keeps
//       receiving subsequent events (no silent deregistration).
//   S5  Tier-2 notifications fire only after flush — no premature
//       notification while events sit in the buffer. Both flush
//       variants exercised: threshold (flushCount) and idle timer
//       (tier2IdleMs).
//
// FIRST-CONTACT LEDGER (corpus doctrine): 2026-10-29 — 1 RED / 27
//   checks. The red was a FIXTURE ARITHMETIC DEFECT, not an
//   implementation failure: S3 expected b=5/c=5 after dispose(),
//   forgetting that dispose() emits the farewell flush AND a shutdown
//   checkpoint, and checkpoints notify (S1's own lesson — the irony
//   is registered). Got b=6/c=6: note.opened (5th) then
//   log.checkpoint (6th), exactly correct seam behavior. Fix: S3
//   now records sibling notification TYPES and names the fifth and
//   sixth arrivals, so the expectation cannot silently drift again.
//   One legitimate first-contact red: the hostility clause is paid.
//
// DECLARED HAZARD, observed while drafting S4 (registered, not fixed —
//   ruling owed): a subscriber that throws on EVERY event, including
//   log.integrity, creates a SELF-SUSTAINING LOOP — throw →
//   reportIntegrity queues a new append → that event fans out →
//   throw → reportIntegrity → ... unbounded shard growth, queue never
//   drains. This fixture deliberately targets its thrower at
//   note.created ONLY (never log.integrity), so it certifies the
//   contract without detonating the loop. Mitigation options when
//   ruled: suppress notify for integrity events born of subscriber
//   errors, or rate-limit per-subscriber error reporting. The hazard
//   is named here so the ruling happens before a hostile consumer
//   finds it in production.
//
// Idiom: spawnContext + FakeAdapter (spine fixtures), NOT pure-module
//   direct-drive — the subject is EventLog itself, so the harness
//   disciplines of rules 1–4 apply: public API only (subscribe,
//   appendEvent, checkpoint, dispose), corruption nowhere, fixed
//   clock, deterministic thresholds.
//
// ASYNC DISCIPLINE (csuite rule): ONE main call, every await spelled
//   out, no IIFE scaffolding. waitUntil polls with a deadline because
//   subscriber-error integrity reports are queued behind the original
//   append (void'd fire-and-forget in the seam) — a hard sleep would
//   be a flaky guess, a poll with a timeout is a bounded witness.
//
// Run:  node ./src/fixtures/f13.ts
// Node note: erasable TS, .ts import extensions.
// =============================================================================

import { spawnContext, shardPath } from '../test-harness.ts';

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

let checks = 0;
let failures = 0;

function check(name: string, ok: boolean, detail?: string): boolean {
    checks++;
    if (ok) return true;
    failures++;
    console.log(`[FAIL] ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
    return true;
}

const FIXED_TS = '2026-10-29T10:00:00+00:00';

function readEvents(
    fs: { read(p: string): string | undefined },
                    shard: string,
): Array<Record<string, unknown>> {
    return (fs.read(shard) ?? '')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Bounded poll: condition checked every 5ms, deadline in ms. */
async function waitUntil(cond: () => boolean, deadlineMs = 1000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        if (cond()) return true;
        await new Promise((r) => setTimeout(r, 5));
    }
    return cond();
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** Uniform payloads — nothing exotic, the seam is the subject. */
const T1_PAYLOAD = { path: 'Notes/f13.md', mtime: 1763000000000, bytes: 100, content_sha: 'aaaa1111bbbb2222' };
const T2_PAYLOAD = { path: 'Notes/f13.md', dwell: 10 };

// -----------------------------------------------------------------------------
// S1 — All categories, notification AFTER disk append
// -----------------------------------------------------------------------------

async function s1AllCategories(): Promise<void> {
    const ROOT = '/f13-s1';
    const { log, fs } = spawnContext('mokka', ROOT, {
        now: () => FIXED_TS,
                                     settings: { tier2FlushCount: 2, tier2IdleMs: 60_000, checkpointInterval: 10_000 },
    });
    const SHARD = shardPath(ROOT, 'mokka');

    const seen: Array<{ type: string; seq: number; onDiskAtCallback: boolean }> = [];
    log.subscribe('s1-witness', (event) => {
        // DISK-AT-CALLBACK WITNESS: when the callback fires, the
        // notified event's own seq must already be on disk. This is
        // "notification latency == persistence latency" made falsifiable.
        const onDisk = readEvents(fs, SHARD).some((e) => e.seq === event.seq);
        seen.push({ type: event.type, seq: event.seq, onDiskAtCallback: onDisk });
    });

    // Tier-2 first (hardest ordering case): one note.opened buffers.
    await log.appendEvent('user', 'note.opened', T2_PAYLOAD);
    check('S1 Tier-2 buffered: no notification yet', seen.length === 0, `${seen.length}`);

    // Second Tier-2 crosses flushCount 2 → flush → BOTH notify.
    await log.appendEvent('user', 'note.opened', { ...T2_PAYLOAD, dwell: 20 });
    check('S1 Tier-2 flush: both buffered events notified', seen.length === 2, `${seen.length}`);
    check('S1 both are note.opened',
          seen.length === 2 && seen.every((s) => s.type === 'note.opened'),
          seen.map((s) => s.type).join(','));

    // Tier-1 write-through: immediate.
    await log.appendEvent('user', 'note.created', T1_PAYLOAD);
    check('S1 Tier-1: notified immediately', seen.length === 3, `${seen.length}`);

    // Checkpoint: manual, its own append + notification.
    await log.checkpoint();
    check('S1 checkpoint: notified', seen.length === 4, `${seen.length}`);
    check('S1 all three categories arrived',
          seen.some((s) => s.type === 'note.opened') &&
          seen.some((s) => s.type === 'note.created') &&
          seen.some((s) => s.type === 'log.checkpoint'),
          seen.map((s) => s.type).join(','));

    // The persistence-latency invariant, every event, no exceptions.
    check('S1 every notification saw its own line on disk',
          seen.every((s) => s.onDiskAtCallback),
          seen.filter((s) => !s.onDiskAtCallback).map((s) => s.seq).join(','));

    // Seq order: notifications arrive in seq order (causal inheritance
    // from the serialized queue).
    const seqs = seen.map((s) => s.seq);
    check('S1 notifications in seq order',
          seqs.every((v, i) => i === 0 || v > seqs[i - 1]), seqs.join(','));

    await log.dispose();
}

// -----------------------------------------------------------------------------
// S2 — FIFO registration order
// -----------------------------------------------------------------------------

async function s2FifoOrder(): Promise<void> {
    const ROOT = '/f13-s2';
    const { log } = spawnContext('mokka', ROOT, {
        now: () => FIXED_TS,
                                 settings: { tier2FlushCount: 64, tier2IdleMs: 60_000 },
    });

    const order: string[] = [];
    log.subscribe('alpha', () => order.push('alpha'));
    log.subscribe('beta', () => order.push('beta'));

    const N = 5;
    for (let i = 0; i < N; i++) {
        await log.appendEvent('user', 'note.created', {
            ...T1_PAYLOAD, path: `Notes/s2-${i}.md`,
        });
    }

    // Alpha precedes Beta on EVERY event — FIFO per event, not just
    // overall registration. Length-guarded against vacuous pass.
    check(`S2 order is alpha,beta × ${N}`, order.length === 2 * N &&
    order.every((who, i) => who === (i % 2 === 0 ? 'alpha' : 'beta')),
          order.join(','));

    // Late registration still honors relative order among the rest.
    const lateOrder: string[] = [];
    log.subscribe('gamma', () => lateOrder.push('gamma'));
    await log.appendEvent('user', 'note.created', { ...T1_PAYLOAD, path: 'Notes/s2-late.md' });
    check('S2 late subscriber receives too', lateOrder.length === 1, `${lateOrder.length}`);
    check('S2 originals still FIFO after late join', order.length === 2 * (N + 1) &&
    order[order.length - 2] === 'alpha' && order[order.length - 1] === 'beta',
    order.slice(-3).join(','));

    await log.dispose();
}

// -----------------------------------------------------------------------------
// S3 — Unsubscribe stops delivery; others unaffected; idempotent handle
// -----------------------------------------------------------------------------

async function s3Unsubscribe(): Promise<void> {
    const ROOT = '/f13-s3';
    const { log } = spawnContext('mokka', ROOT, {
        now: () => FIXED_TS,
                                 settings: { tier2FlushCount: 64, tier2IdleMs: 60_000 },
    });

    let a = 0;
    // Siblings record TYPES, not just counts: dispose() fires the
    // farewell flush AND a shutdown checkpoint, and BOTH notify — the
    // first-contact red taught this. Naming the arrivals keeps the
    // arithmetic honest forever.
    const bTypes: string[] = [];
    const cTypes: string[] = [];

    const offA = log.subscribe('a', () => a++);
    log.subscribe('b', (e) => bTypes.push(e.type));
    log.subscribe('c', (e) => cTypes.push(e.type));

    await log.appendEvent('user', 'note.created', { ...T1_PAYLOAD, path: 'Notes/s3-1.md' });
    check('S3 warm-up: all three received', a === 1 && bTypes.length === 1 && cTypes.length === 1,
          `a=${a} b=${bTypes.length} c=${cTypes.length}`);

    offA();
    offA(); // IDEMPOTENT: second call must be a harmless no-op.

    for (let i = 0; i < 3; i++) {
        await log.appendEvent('user', 'note.created', { ...T1_PAYLOAD, path: `Notes/s3-2-${i}.md` });
    }

    check('S3 unsubscribed subscriber frozen at 1', a === 1, `${a}`);
    check('S3 siblings received all subsequent events',
          bTypes.length === 4 && cTypes.length === 4,
          `b=${bTypes.length} c=${cTypes.length}`);

    // Farewell: the buffered note.opened flushes (notifies), then
    // dispose() emits the shutdown checkpoint (ALSO notifies — S1's
    // lesson). Expect exactly one of each, in that order.
    await log.appendEvent('user', 'note.opened', T2_PAYLOAD);
    await log.dispose();

    check('S3 unsubscribed deaf to the farewell flush AND checkpoint', a === 1, `${a}`);
    check('S3 siblings: 6 arrivals = 4 creates + flush + checkpoint',
          bTypes.length === 6 && cTypes.length === 6,
          `b=${bTypes.length} [${bTypes.join(',')}] c=${cTypes.length}`);
    check('S3 fifth sibling arrival is the flushed Tier-2',
          bTypes[4] === 'note.opened', bTypes.join(','));
    check('S3 sixth sibling arrival is the shutdown checkpoint',
          bTypes[5] === 'log.checkpoint', bTypes.join(','));
    check('S3 both siblings agree on the sequence',
          bTypes.join(',') === cTypes.join(','),
          `b=[${bTypes.join(',')}] c=[${cTypes.join(',')}]`);
}

// -----------------------------------------------------------------------------
// S4 — Subscriber throw: named integrity report, writer survives
// -----------------------------------------------------------------------------

async function s4ThrowContainment(): Promise<void> {
    const ROOT = '/f13-s4';
    const { log, fs } = spawnContext('mokka', ROOT, {
        now: () => FIXED_TS,
                                     settings: { tier2FlushCount: 64, tier2IdleMs: 60_000 },
    });
    const SHARD = shardPath(ROOT, 'mokka');

    // Monitor: passive recorder of everything, including the integrity
    // events S4 exists to produce.
    const seen: Array<{ type: string; detail?: unknown }> = [];
    log.subscribe('monitor', (event) => {
        seen.push({ type: event.type, detail: (event.payload as { detail?: unknown }).detail });
    });

    // Thrower: throws on note.created ONLY — never on log.integrity.
    // The targeting is deliberate: a subscriber throwing on every
    // event would self-sustain (see DECLARED HAZARD in the header).
    let threw = 0;
    log.subscribe('thrower', (event) => {
        if (event.type === 'note.created') {
            threw++;
            throw new Error(`boom #${threw}`);
        }
    });

    const appendPromise = log.appendEvent('user', 'note.created', T1_PAYLOAD);

    // The append itself must RESOLVE despite the subscriber throwing —
    // error containment, not error swallowing-and-stalling.
    let appendResolved = false;
    await appendPromise.then(() => { appendResolved = true; });
    check('S4 writer survived the throw (append resolved)', appendResolved);

    // The integrity report is queued behind the append (the seam
    // voids it fire-and-forget); poll for its arrival on disk.
    const reported = await waitUntil(() =>
    readEvents(fs, SHARD).some((e) =>
    e.type === 'log.integrity' &&
    typeof e.detail === 'string' &&
    e.detail.includes('thrower')),
    );
    check('S4 log.integrity emitted naming the subscriber', reported);

    const integrityLine = readEvents(fs, SHARD).find((e) =>
    e.type === 'log.integrity' && typeof e.detail === 'string' && e.detail.includes('thrower'));
    check('S4 integrity detail carries the boom', typeof integrityLine?.detail === 'string' &&
    (integrityLine.detail as string).includes('boom #1'), `${integrityLine?.detail ?? '(none)'}`);

    // Writer AND the thrower both continue: no silent deregistration,
    // no poisoned queue.
    await log.appendEvent('user', 'note.renamed', { from: 'Notes/a.md', to: 'Notes/b.md' });
    const got = await waitUntil(() => seen.some((s) => s.type === 'note.renamed'));
    check('S4 writer continues emitting after containment', got);
    check('S4 monitor saw the follow-up event',
          seen.some((s) => s.type === 'note.renamed'), seen.map((s) => s.type).join(','));

    await log.dispose();
}

// -----------------------------------------------------------------------------
// S5 — Tier-2 notifies only after flush (threshold + idle variants)
// -----------------------------------------------------------------------------

async function s5PostFlushOnly(): Promise<void> {
    // --- Variant 1: threshold (flushCount) ---
    {
        const ROOT = '/f13-s5a';
        const { log } = spawnContext('mokka', ROOT, {
            now: () => FIXED_TS,
                                     settings: { tier2FlushCount: 3, tier2IdleMs: 60_000 },
        });

        let notified = 0;
        log.subscribe('threshold-watch', () => notified++);

        await log.appendEvent('user', 'note.opened', { ...T2_PAYLOAD, dwell: 11 });
        await log.appendEvent('user', 'note.opened', { ...T2_PAYLOAD, dwell: 12 });
        check('S5a two buffered: zero notifications', notified === 0, `${notified}`);

        // Third event crosses flushCount 3 → buffer drains → 3 notify.
        await log.appendEvent('user', 'note.opened', { ...T2_PAYLOAD, dwell: 13 });
        check('S5a flush at threshold: all three notified', notified === 3, `${notified}`);

        await log.dispose();
    }

    // --- Variant 2: idle timer (tier2IdleMs) ---
    {
        const ROOT = '/f13-s5b';
        const { log } = spawnContext('mokka', ROOT, {
            now: () => FIXED_TS,
                                     settings: { tier2FlushCount: 64, tier2IdleMs: 40 },
        });

        let notified = 0;
        log.subscribe('idle-watch', () => notified++);

        await log.appendEvent('user', 'note.opened', { ...T2_PAYLOAD, dwell: 21 });
        check('S5b buffered: zero notifications immediately', notified === 0, `${notified}`);

        // The idle timer fires the flush asynchronously. Poll — the
        // deadline makes the wait a witness, not a sleep-sized guess.
        const flushed = await waitUntil(() => notified > 0, 1000);
        check('S5b idle flush delivered the notification', flushed, `${notified}`);
        check('S5b exactly one notification for one event', notified === 1, `${notified}`);

        await sleep(60); // quiet corridor: no further arrivals
        check('S5b no phantom re-notification', notified === 1, `${notified}`);

        await log.dispose();
    }
}

// -----------------------------------------------------------------------------
// Registry + main — ONE main call (csuite rule)
// -----------------------------------------------------------------------------

const SCENARIOS: Array<{ id: string; run: () => Promise<void> }> = [
    { id: 'S1', run: s1AllCategories },
{ id: 'S2', run: s2FifoOrder },
{ id: 'S3', run: s3Unsubscribe },
{ id: 'S4', run: s4ThrowContainment },
{ id: 'S5', run: s5PostFlushOnly },
];

async function main(): Promise<void> {
    for (const s of SCENARIOS) {
        const failBefore = failures;
        try {
            await s.run();
        } catch (err) {
            check(`${s.id} completed without throw`, false, String(err));
        }
        console.log(`[${s.id}] ${failures === failBefore ? 'GREEN' : 'RED'}`);
    }
    console.log('');
    if (failures === 0) {
        console.log(`F13: ALL GREEN (${checks} checks, ${SCENARIOS.length} scenarios)`);
    } else {
        console.log(`F13: ${failures} RED (out of ${checks} checks)`);
    }
}

main().then(() => {
    if (failures > 0) process.exitCode = 1;
});
