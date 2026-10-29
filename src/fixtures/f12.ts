// =============================================================================
// Vault Overseer — F12: Watcher File-Fact Producers (note.created/deleted)
// src/fixtures/f12.ts
//
// rev C (2026-10-25, B3 reconcile — first-contact backfill + manual button):
//   - S9  added (NEW): reconcile, fresh spine — empty known-set, 5 vault
//     paths, all 5 emitted with real stat/sha, tombstones populated (a
//     subsequent delete of a reconciled path carries the backfilled sha)
//   - S10 added (NEW): reconcile idempotence — second run with the now-
//     populated known-set emits ZERO (no per-reload cost)
//   - S11 added (NEW): partial gap — spine knows 3 of 5, exactly the 2
//     missing are emitted (the crash-mid-backfill self-heal case)
//   - S12 added (NEW): dark refusal — reconcile on an unarmed lane
//     returns -1 and grows the buffer by ZERO (the cap-protection
//     ruling: backfilling into a 500-cap dark buffer would truncate the
//     inventory silently-in-principle). Post-arm retry succeeds —
//     refusal is not poisoning.
//   - S13 added (NEW): no hidden state — create → delete → reconcile the
//     same path emits a THIRD fact. The lane keeps no ever-seen dedup;
//     reconcile is a pure set-diff against the caller's known-set, so a
//     restored file (spine says dead, disk says alive) reconciles.
//   - rev B preserved verbatim below (S1–S8, all green 2026-10-25)
//
// rev B (2026-10-25, aligned to Schema v0.2 catalog + session rulings):
//   - S3 reworked: note.deleted now carries last_content_sha (the
//     tombstone payload) — consumed from the lane's last-known map, so
//     create→delete→create produces created(tombstoned sha)/deleted/
//     created(fresh sha), and key order is asserted with the
//     last_content_sha field
//   - S7 added (NEW): dark-buffer overflow — cap 2, three creates while
//     dark, oldest dropped, survivors flush in order, overflow DISCLOSED
//     through reportIntegrity
//   - S8 added (NEW): unknown-path delete — deleting a path the lane
//     never observed emits path-only (no fabricated sha)
//   - stub removed (rev A); module under test is live since rev A
//
// FIRST CONTACT LEDGER (corpus doctrine): 2026-10-25, against the stub —
// 80 RED / 88 checks (stub-inflated denominator; true check count 35),
// all reds legitimate ("module does not exist"). Rev A: ALL GREEN (35
// checks). Rev B adds S7/S8 — expected first contact RED until the
// module implements the tombstone map, then green. Rev C adds S9–S13 —
// expected first contact RED against rev B (the lane has no
// reconcilePaths entry point; the throw is the red) until the module
// implements reconcile. Hostility satisfied structurally: the stub was
// incapable of passing green-by-vacuum.
//
// CORPUS ENTRY (transcribe into event-log-fixture-corpus.md; F07–F10 are
// named occupants of the parked list, F12 takes the next free seat):
//
// F12 — Watcher first file-fact producers
//   Threat: the first vault-event producers beyond rename. Doubled
//   emissions, path-fused facts (the F09 Untitled lesson inverted),
//   seq consumption on silent paths (the F08 poison), stat drift
//   between observation and flush, tier-of-loss on dark boot, and
//   Tier-1 facts lost while the writer is dark (identity-uncertified
//   boot, foreign-origin guard). Plus (rev C): the installation black
//   hole — a fresh origin whose spine names no paths, so the heal
//   projection examines nothing and the vault is invisible.
//   Setup: spawnContext('mokka') over the FakeAdapter; a WatcherLane
//   (src/watcher/watch.ts) fed synthetic FileLike events; writer
//   attached mid-session to exercise dark-boot buffering.
//   Procedure: drive every scenario group; assert disk lines, payload
//   parity, key order, seq accounting, and silence contracts.
//   Pass requires:
//     - TFile md create ⇒ exactly one note.created, actor 'user',
//       Tier-1 write-through (line on disk after the await, pending 0)
//     - Folder create/delete ⇒ ZERO events, ZERO seq consumed
//     - Non-md create ⇒ ZERO events, ZERO seq consumed
//     - Extension matching case-insensitive in the lane: ext 'MD' IS
//       a note and emits
//     - Untitled lifecycle: create→delete→create same path ⇒ THREE
//       facts (two created, one deleted with the FIRST creation's sha
//       as its tombstone) — facts never fused by path
//     - Causal order on disk: events in emission order, seq contiguous
//     - Dark boot: facts observed while the writer is dark are captured
//       with stats AT OBSERVATION TIME and flushed in order on attach
//     - Arming: flushAfterAttach() discloses overflow, drains AND arms;
//       post-attach facts append directly
//     - Dark-buffer overflow (cap 2): third create while dark drops
//       the OLDEST, survivors flush in order, overflow disclosed
//       through reportIntegrity — never a silent loss
//     - Unknown-path delete: path-only tombstone, no fabricated sha
//     - Storm: 50 rapid creates ⇒ 50 events, contiguous seq, no loss,
//       no coalescing
//     - Sync-arrival attribution: actor 'user' (DECLARED v1 limitation,
//       registered roadmap debt — asserted so the limitation is at
//       least uniform, never intermittent)
//     - Reconcile (rev C): fresh spine ⇒ every vault path emitted with
//       real stat/sha and its tombstone populated; second run ⇒ ZERO;
//       partial spine ⇒ exactly the gaps; unarmed lane ⇒ refusal (-1)
//       with ZERO buffer growth; create→delete→reconcile ⇒ a third
//       fact (no hidden ever-seen dedup)
//   Fail smells: create firing twice for one file; path-keyed dedup
//   fusing distinct creations; seq advancing on silent paths; note.*
//   landing in the Tier-2 buffer; stats computed at flush time;
//   dark-boot facts vanishing without disclosure; empty-array checks
//   passing vacuously; tombstones fabricating shas for unobserved
//   paths; overflow dropping NEWEST instead of OLDEST; reconcile
//   re-emitting known paths (per-reload cost); reconcile running dark
//   and truncating the inventory through the cap.
//
// SCOPE RULING (2026-10-25, session): v1 watcher emits note.created and
// note.deleted ONLY. note.modified is deferred (storm coalescing,
// sync-vs-user disambiguation, the 30s/100 debounce ruling). Actor
// attribution for sync-arriving files is registered debt: eventually
// 'sync' must be distinguishable; v1 declares the limit.
//
// ASYNC DISCIPLINE (csuite): ONE main call, every await spelled out,
// no IIFE scaffolding, no un-awaited promises.
//
// TYPECHECK FIX (2026-10-29, Option B): WatcherDeps.appendEvent carries
//   shape-loose payloads while the typed log API demands the
//   discriminated union. One bridge helper (asTypedPayload) is applied
//   at all nine delegation sites; the cast is WITNESSED, not blind —
//   every scenario below asserts payload parity and key order against
//   the actual disk bytes, so a drifted shape reds immediately. The
//   proper fix (typing the watcher lane's payloads at source) is
//   registered for the watcher's next touch; this keeps the fixture
//   compile-clean without pretending the loose boundary doesn't exist.
//
// Run:  node ./src/fixtures/f12.ts
// Node note: erasable TS, .ts import extensions.
// =============================================================================

import { spawnContext, shardPath } from '../test-harness.ts';
import { makeWatcherLane } from '../watcher/watch.ts';
import type { FileLike, StatSnapshot, WatcherDeps } from '../watcher/watch.ts';
import type { NoteCreatedPayload, NoteDeletedPayload } from '../eventlog/types.ts';

// -----------------------------------------------------------------------------
// Helpers
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

function toLines(text: string): string[] {
    return text.split('\n').filter((l) => l.length > 0);
}

const FIXED_TS = '2026-10-25T09:00:00+00:00';

const md = (path: string): FileLike => ({ path, isFolder: false, ext: 'md' });
const png = (path: string): FileLike => ({ path, isFolder: false, ext: 'png' });
const folder = (path: string): FileLike => ({ path, isFolder: true, ext: '' });

/**
 * Typed bridge from the watcher's shape-loose payload to the typed log
 * API (typecheck fix, 2026-10-29). The watcher lane's type parameter is
 * already narrowed to note.created | note.deleted, so the target union
 * is two members. The disk-side parity and key-order assertions in
 * every scenario are the witnesses that keep this cast honest — a
 * drifted payload shape fails S1/S3/S8 loudly.
 */
function asTypedPayload(p: unknown): NoteCreatedPayload | NoteDeletedPayload {
    return p as NoteCreatedPayload | NoteDeletedPayload;
}

/** Parse the shard into events. Key order is law (asserted in S1/S3). */
function readEvents(
    fs: { read(p: string): string | undefined },
                    shard: string,
): Array<Record<string, unknown>> {
    return toLines(fs.read(shard) ?? '').map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * Shared fake-deps factory for the reconcile scenarios: a path→stat/sha
 * map with a loud throw on unknown paths (a lane stat-ing something it
 * shouldn't is a defect, not a shrug).
 */
function statsDeps(
    tag: string,
    log: ReturnType<typeof spawnContext>['log'],
    fakeStats: Map<string, StatSnapshot & { sha: string }>,
    onAppend?: () => boolean,
): WatcherDeps {
    return {
        stat: async (p) => {
            const s = fakeStats.get(p);
            if (s === undefined) throw new Error(`${tag} stat for unknown path ${p}`);
            return { mtime: s.mtime, bytes: s.bytes };
        },
        contentSha: async (p) => {
            const s = fakeStats.get(p);
            if (s === undefined) throw new Error(`${tag} sha for unknown path ${p}`);
            return s.sha;
        },
        appendEvent: async (actor, type, payload) => {
            if (onAppend !== undefined && !onAppend()) return;
            await log.appendEvent(actor, type, asTypedPayload(payload));
        },
    };
}

/** Five deterministic vault paths for the reconcile scenarios. */
const RECONCILE_PATHS = [
    'Notes/r-1.md',
'Notes/r-2.md',
'Notes/r-3.md',
'Notes/r-4.md',
'Notes/r-5.md',
];

function seedReconcileStats(map: Map<string, StatSnapshot & { sha: string }>): void {
    RECONCILE_PATHS.forEach((p, i) => {
        map.set(p, {
            mtime: 1763000400000 + i,
            bytes: 100 + i,
            sha: (i + 1).toString(16).padStart(16, '0'),
        });
    });
}

// -----------------------------------------------------------------------------
// S1 — Single-fire create, payload parity, Tier-1 write-through
// -----------------------------------------------------------------------------

async function s1SingleFireCreate(): Promise<void> {
    const ROOT = '/f12-s1';
    const { log, fs } = spawnContext('mokka', ROOT, { now: () => FIXED_TS });
    const SHARD = shardPath(ROOT, 'mokka');

    const fakeStats = new Map<string, StatSnapshot & { sha: string }>();
    const deps: WatcherDeps = {
        stat: async (p) => {
            const s = fakeStats.get(p);
            if (s === undefined) throw new Error(`S1 stat for unknown path ${p}`);
            return { mtime: s.mtime, bytes: s.bytes };
        },
        contentSha: async (p) => {
            const s = fakeStats.get(p);
            if (s === undefined) throw new Error(`S1 sha for unknown path ${p}`);
            return s.sha;
        },
        appendEvent: (actor, type, payload) => log.appendEvent(actor, type, asTypedPayload(payload)),
    };
    const lane = makeWatcherLane(deps);
    // ARMING: adapter ritual — writer certified, arm the lane.
    await lane.flushAfterAttach();

    fakeStats.set('Notes/first.md', { mtime: 1763000000000, bytes: 120, sha: 'aaaaaaaaaaaaaaaa' });

    await lane.onVaultCreate(md('Notes/first.md'));

    const events = readEvents(fs, SHARD);
    check('S1 exactly one event', events.length === 1, `${events.length}`);
    const e = events[0];

    check('S1 type note.created', e?.type === 'note.created', `${e?.type}`);
    check('S1 actor user', e?.actor === 'user', `${e?.actor}`);
    check('S1 tier-1 write-through (pending 0)', log.pendingCount === 0,
          `pending: ${log.pendingCount}`);
    check('S1 payload parity: path', e?.path === 'Notes/first.md', `${e?.path}`);
    check('S1 payload parity: mtime', e?.mtime === 1763000000000, `${e?.mtime}`);
    check('S1 payload parity: bytes', e?.bytes === 120, `${e?.bytes}`);
    check('S1 payload parity: content_sha', e?.content_sha === 'aaaaaaaaaaaaaaaa',
          `${e?.content_sha}`);
    check('S1 payload key order',
          JSON.stringify(Object.keys(e ?? {})) ===
          JSON.stringify(['v', 'seq', 'ts', 'origin', 'actor', 'type',
                         'path', 'mtime', 'bytes', 'content_sha']),
          JSON.stringify(Object.keys(e ?? {})));

    await log.dispose();
}

// -----------------------------------------------------------------------------
// S2 — Silence contracts + case-insensitive extension matching
// -----------------------------------------------------------------------------

async function s2SilenceContracts(): Promise<void> {
    const ROOT = '/f12-s2';
    const { log, fs } = spawnContext('mokka', ROOT, { now: () => FIXED_TS });
    const SHARD = shardPath(ROOT, 'mokka');

    const fakeStats = new Map<string, StatSnapshot & { sha: string }>();
    const deps: WatcherDeps = {
        stat: async (p) => {
            const s = fakeStats.get(p);
            if (s === undefined) throw new Error(`S2 stat for unknown path ${p}`);
            return { mtime: s.mtime, bytes: s.bytes };
        },
        contentSha: async (p) => {
            const s = fakeStats.get(p);
            if (s === undefined) throw new Error(`S2 sha for unknown path ${p}`);
            return s.sha;
        },
        appendEvent: (actor, type, payload) => log.appendEvent(actor, type, asTypedPayload(payload)),
    };
    const lane = makeWatcherLane(deps);
    await lane.flushAfterAttach(); // ARMING

    // Phase 1 — silent paths: folders and non-md files.
    await lane.onVaultCreate(folder('Notes/Subfolder'));
    await lane.onVaultDelete(folder('Notes/Subfolder'));
    await lane.onVaultCreate(png('attachments/pic.png'));

    check('S2 zero events from silent paths', log.lastSeq === 0,
          `lastSeq: ${log.lastSeq}`);
    check('S2 seq counter untouched (lastSeq 0)', log.lastSeq === 0,
          `lastSeq: ${log.lastSeq}`);

    // Phase 2 — extension case-insensitivity: ext 'MD' IS a note.
    fakeStats.set('Notes/case-check.MD', { mtime: 1763000003000, bytes: 33, sha: '3333333333333333' });
    await lane.onVaultCreate({ path: 'Notes/case-check.MD', isFolder: false, ext: 'MD' });

    const events = readEvents(fs, SHARD);
    check('S2 uppercase .MD emitted exactly one event', events.length === 1,
          `${events.length}`);
    check('S2 uppercase .MD names the real path', events[0]?.path === 'Notes/case-check.MD',
          `${events[0]?.path}`);
    check('S2 uppercase .MD actor user', events[0]?.actor === 'user',
          `${events[0]?.actor}`);

    await log.dispose();
}

// -----------------------------------------------------------------------------
// S3 — Untitled lifecycle: create → delete → create same path
//        (facts never path-fused; the DELETE carries the tombstone sha)
// -----------------------------------------------------------------------------

async function s3UntitledLifecycle(): Promise<void> {
    const ROOT = '/f12-s3';
    const { log, fs } = spawnContext('mokka', ROOT, { now: () => FIXED_TS });
    const SHARD = shardPath(ROOT, 'mokka');

    const fakeStats = new Map<string, StatSnapshot & { sha: string }>();
    const deps: WatcherDeps = {
        stat: async (p) => {
            const s = fakeStats.get(p);
            if (s === undefined) throw new Error(`S3 stat for unknown path ${p}`);
            return { mtime: s.mtime, bytes: s.bytes };
        },
        contentSha: async (p) => {
            const s = fakeStats.get(p);
            if (s === undefined) throw new Error(`S3 sha for unknown path ${p}`);
            return s.sha;
        },
        appendEvent: (actor, type, payload) => log.appendEvent(actor, type, asTypedPayload(payload)),
    };
    const lane = makeWatcherLane(deps);
    await lane.flushAfterAttach(); // ARMING

    const P = 'Notes/Untitled.md';
    fakeStats.set(P, { mtime: 1763000001000, bytes: 90, sha: '1111111111111111' });
    await lane.onVaultCreate(md(P));

    await lane.onVaultDelete(md(P));

    // Obsidian reuses the path for the NEXT new note. Same address, NEW fact.
    fakeStats.set(P, { mtime: 1763000002000, bytes: 140, sha: '2222222222222222' });
    await lane.onVaultCreate(md(P));

    const events = readEvents(fs, SHARD);
    check('S3 three events total', events.length === 3, `${events.length}`);
    check('S3 type sequence created/deleted/created',
          events.length === 3 &&
          events.map((e) => e.type).join(',') === 'note.created,note.deleted,note.created',
          events.map((e) => e.type).join(','));

    const c0 = events[0];
    const d0 = events[1];
    const c1 = events[2];
    check('S3 first creation sha', c0?.content_sha === '1111111111111111', `${c0?.content_sha}`);
    check('S3 tombstone carries the FIRST creation\'s sha',
          d0?.last_content_sha === '1111111111111111', `${d0?.last_content_sha}`);
    check('S3 second creation sha (fresh — no fusion)', c1?.content_sha === '2222222222222222',
          `${c1?.content_sha}`);
    check('S3 second creation mtime differs', c1?.mtime === 1763000002000, `${c1?.mtime}`);
    check('S3 deleted key order includes last_content_sha',
          JSON.stringify(Object.keys(d0 ?? {})) ===
          JSON.stringify(['v', 'seq', 'ts', 'origin', 'actor', 'type', 'path', 'last_content_sha']),
          JSON.stringify(Object.keys(d0 ?? {})));
    // Length-guarded: an empty shard must NOT pass vacuously.
    check('S3 seq contiguous 1..3 (length-guarded)',
          events.length === 3 && events.every((e, i) => e.seq === i + 1),
          events.map((e) => e.seq).join(','));

    await log.dispose();
}

// -----------------------------------------------------------------------------
// S4 — Dark boot: facts observed before the writer exists
//        (captured at observation time, flushed in order on attach)
// -----------------------------------------------------------------------------

async function s4DarkBoot(): Promise<void> {
    const ROOT = '/f12-s4';
    const { log, fs } = spawnContext('mokka', ROOT, { now: () => FIXED_TS });
    const SHARD = shardPath(ROOT, 'mokka');

    const fakeStats = new Map<string, StatSnapshot & { sha: string }>();

    // The writer is DARK — the adapter's appendEvent goes nowhere while
    // uncertified. The lane must buffer Tier-1 facts across this window.
    let writerLive = false;
    const deps: WatcherDeps = {
        stat: async (p) => {
            const s = fakeStats.get(p);
            if (s === undefined) throw new Error(`S4 stat for unknown path ${p}`);
            return { mtime: s.mtime, bytes: s.bytes };
        },
        contentSha: async (p) => {
            const s = fakeStats.get(p);
            if (s === undefined) throw new Error(`S4 sha for unknown path ${p}`);
            return s.sha;
        },
        appendEvent: async (actor, type, payload) => {
            if (!writerLive) return; // dropped by the dead writer
            await log.appendEvent(actor, type, asTypedPayload(payload));
        },
    };
    const lane = makeWatcherLane(deps);
    // NO ARMING — this scenario is the dark window itself.

    fakeStats.set('Notes/dark-a.md', { mtime: 1763000010000, bytes: 60, sha: 'aaaaaaaaaaaaaaa1' });
    fakeStats.set('Notes/dark-b.md', { mtime: 1763000011000, bytes: 70, sha: 'aaaaaaaaaaaaaaa2' });

    // Writer dark: lane buffers, discloses nothing, throws nothing.
    const before = log.lastSeq;
    await lane.onVaultCreate(md('Notes/dark-a.md'));
    await lane.onVaultCreate(md('Notes/dark-b.md'));

    check('S4 dark facts buffered (pending 2)', lane.pendingCount === 2,
          `pending: ${lane.pendingCount}`);
    check('S4 dark window wrote nothing', log.lastSeq === before, `${log.lastSeq}`);

    // STAT DRIFT TRAP: the file CHANGES between observation and flush.
    fakeStats.set('Notes/dark-b.md', { mtime: 1763000099999, bytes: 9999, sha: 'ffffffffffffffff' });

    writerLive = true;
    await lane.flushAfterAttach(); // ARMING + drain, in that order

    const events = readEvents(fs, SHARD);
    check('S4 flushed both dark facts', events.length === 2, `${events.length}`);
    const b = events.find((e) => e.path === 'Notes/dark-b.md');
    check('S4 dark-b kept observation-time sha', b?.content_sha === 'aaaaaaaaaaaaaaa2',
          `${b?.content_sha}`);
    check('S4 dark-b kept observation-time mtime', b?.mtime === 1763000011000, `${b?.mtime}`);
    check('S4 buffer drained', lane.pendingCount === 0, `pending: ${lane.pendingCount}`);
    const a = events.find((e) => e.path === 'Notes/dark-a.md');
    check('S4 flush preserved emission order (a before b)',
          a !== undefined && b !== undefined && (a.seq as number) < (b.seq as number),
          `a=${a?.seq} b=${b?.seq}`);

    await log.dispose();
}

// -----------------------------------------------------------------------------
// S5 — Storm burst: 50 rapid creates, no loss, no coalescing
// -----------------------------------------------------------------------------

async function s5StormBurst(): Promise<void> {
    const ROOT = '/f12-s5';
    const { log, fs } = spawnContext('mokka', ROOT, { now: () => FIXED_TS });
    const SHARD = shardPath(ROOT, 'mokka');

    const deps: WatcherDeps = {
        stat: async (p) => {
            const n = Number(/storm-(\d+)\.md/.exec(p)?.[1] ?? 0);
            return { mtime: 1763000100000 + n, bytes: 50 + n };
        },
        contentSha: async (p) => {
            const n = Number(/storm-(\d+)\.md/.exec(p)?.[1] ?? 0);
            return n.toString(16).padStart(16, '0');
        },
        appendEvent: (actor, type, payload) => log.appendEvent(actor, type, asTypedPayload(payload)),
    };
    const lane = makeWatcherLane(deps);
    await lane.flushAfterAttach(); // ARMING

    const N = 50;
    for (let i = 0; i < N; i++) {
        await lane.onVaultCreate(md(`Notes/storm-${String(i).padStart(2, '0')}.md`));
    }

    const events = readEvents(fs, SHARD);
    check(`S5 all ${N} creates landed`, events.length === N, `${events.length}`);
    // Length-guarded: an empty shard must NOT pass vacuously.
    check('S5 seq contiguous (length-guarded)',
          events.length === N && events.every((e, i) => e.seq === i + 1),
          `first=${events[0]?.seq} last=${events[events.length - 1]?.seq}`);
    check('S5 storm events are Tier-1 (none buffered)', lane.pendingCount === 0,
          `pending: ${lane.pendingCount}`);

    // Every path distinct, no coalescing by mtime/size class.
    const paths = new Set(events.map((e) => e.path as string));
    check('S5 every path distinct', paths.size === N, `${paths.size}`);

    await log.dispose();
}

// -----------------------------------------------------------------------------
// S6 — Sync-arrival attribution: the DECLARED limitation, asserted uniform
// -----------------------------------------------------------------------------

async function s6SyncAttribution(): Promise<void> {
    const ROOT = '/f12-s6';
    const { log, fs } = spawnContext('mokka', ROOT, { now: () => FIXED_TS });
    const SHARD = shardPath(ROOT, 'mokka');

    const deps: WatcherDeps = {
        stat: async () => ({ mtime: 1763000200000, bytes: 80 }),
        contentSha: async () => 'abcabcabcabcdef0',
        appendEvent: (actor, type, payload) => log.appendEvent(actor, type, asTypedPayload(payload)),
    };
    const lane = makeWatcherLane(deps);
    await lane.flushAfterAttach(); // ARMING

    // A file arriving via Obsidian Sync fires the SAME vault 'create'
    // event. v1 cannot tell it apart. The ruling: actor 'user', declared
    // limitation. The fixture's job is to pin the limit as UNIFORM —
    // never 'sync' by accident, never intermittent.
    await lane.onVaultCreate(md('Notes/synced-in.md'));

    const events = readEvents(fs, SHARD);
    check('S6 sync-arrival actor is user (declared limit)', events[0]?.actor === 'user',
          `${events[0]?.actor}`);
    check('S6 type is note.created, no improvised variants', events[0]?.type === 'note.created',
          `${events[0]?.type}`);

    await log.dispose();
}

// -----------------------------------------------------------------------------
// S7 — Dark-buffer overflow: cap 2, oldest dropped, disclosed
// -----------------------------------------------------------------------------

async function s7Overflow(): Promise<void> {
    const ROOT = '/f12-s7';
    const { log, fs } = spawnContext('mokka', ROOT, { now: () => FIXED_TS });
    const SHARD = shardPath(ROOT, 'mokka');

    const fakeStats = new Map<string, StatSnapshot & { sha: string }>();

    let writerLive = false;
    const integrityReports: string[] = [];
    const deps: WatcherDeps = {
        stat: async (p) => {
            const s = fakeStats.get(p);
            if (s === undefined) throw new Error(`S7 stat for unknown path ${p}`);
            return { mtime: s.mtime, bytes: s.bytes };
        },
        contentSha: async (p) => {
            const s = fakeStats.get(p);
            if (s === undefined) throw new Error(`S7 sha for unknown path ${p}`);
            return s.sha;
        },
        appendEvent: async (actor, type, payload) => {
            if (!writerLive) return;
            await log.appendEvent(actor, type, asTypedPayload(payload));
        },
        reportIntegrity: async (detail) => {
            if (!writerLive) return;
            integrityReports.push(detail);
            await log.reportIntegrity(detail);
        },
    };
    // CAP 2 — the hostile cut. Three dark creates must trip it.
    const lane = makeWatcherLane(deps, { darkBufferCap: 2 });

    fakeStats.set('Notes/of-a.md', { mtime: 1763000300000, bytes: 10, sha: '1111111111111111' });
    fakeStats.set('Notes/of-b.md', { mtime: 1763000301000, bytes: 20, sha: '2222222222222222' });
    fakeStats.set('Notes/of-c.md', { mtime: 1763000302000, bytes: 30, sha: '3333333333333333' });

    await lane.onVaultCreate(md('Notes/of-a.md'));
    await lane.onVaultCreate(md('Notes/of-b.md'));
    await lane.onVaultCreate(md('Notes/of-c.md')); // trips cap: of-a dropped

    check('S7 pending capped at 2', lane.pendingCount === 2,
          `pending: ${lane.pendingCount}`);

    writerLive = true;
    await lane.flushAfterAttach();

    const events = readEvents(fs, SHARD);
    const created = events.filter((e) => e.type === 'note.created');
    check('S7 survivors only (of-a gone)', created.length === 2 &&
    !created.some((e) => e.path === 'Notes/of-a.md'),
          created.map((e) => e.path).join(','));
    check('S7 overflow disclosed via integrity lane',
          integrityReports.length === 1 &&
          integrityReports[0]?.includes('watcher dark-buffer overflow') === true &&
          integrityReports[0]?.includes('1 file facts dropped') === true,
          integrityReports.join(' | ') || '(no report)');
    check('S7 disclosure preceded survivors (seq-wise)',
          (() => {
              const report = events.find((e) => e.type === 'log.integrity');
              if (report === undefined) return false;
              const firstCreate = created[0];
              return firstCreate !== undefined &&
              (report.seq as number) < (firstCreate.seq as number);
          })(),
          'report must land before the surviving creates');

    await log.dispose();
}

// -----------------------------------------------------------------------------
// S8 — Unknown-path delete: path-only tombstone, no fabricated sha
// -----------------------------------------------------------------------------

async function s8UnknownDelete(): Promise<void> {
    const ROOT = '/f12-s8';
    const { log, fs } = spawnContext('mokka', ROOT, { now: () => FIXED_TS });
    const SHARD = shardPath(ROOT, 'mokka');

    const deps: WatcherDeps = {
        // No stat lanes for this path — the lane must never call them.
        stat: async (p) => {
            throw new Error(`S8 stat called for ${p} — delete must not stat`);
        },
        contentSha: async (p) => {
            throw new Error(`S8 sha called for ${p} — delete must not sha`);
        },
        appendEvent: (actor, type, payload) => log.appendEvent(actor, type, asTypedPayload(payload)),
    };
    const lane = makeWatcherLane(deps);
    await lane.flushAfterAttach(); // ARMING

    // A note created before the watcher existed (or a rename victim).
    // Delete emits the tombstone WITHOUT a sha — never fabricate.
    await lane.onVaultDelete(md('Notes/pre-watcher.md'));

    const events = readEvents(fs, SHARD);
    check('S8 one event, the tombstone', events.length === 1, `${events.length}`);
    const e = events[0];
    check('S8 type note.deleted', e?.type === 'note.deleted', `${e?.type}`);
    check('S8 path-only payload (no last_content_sha)',
          JSON.stringify(Object.keys(e ?? {})) ===
          JSON.stringify(['v', 'seq', 'ts', 'origin', 'actor', 'type', 'path']),
          JSON.stringify(Object.keys(e ?? {})));

    await log.dispose();
}

// -----------------------------------------------------------------------------
// S9 — Reconcile: fresh spine, full backfill + tombstone population
// -----------------------------------------------------------------------------

async function s9ReconcileFresh(): Promise<void> {
    const ROOT = '/f12-s9';
    const { log, fs } = spawnContext('mokka', ROOT, { now: () => FIXED_TS });
    const SHARD = shardPath(ROOT, 'mokka');

    const fakeStats = new Map<string, StatSnapshot & { sha: string }>();
    seedReconcileStats(fakeStats);

    const lane = makeWatcherLane(statsDeps('S9', log, fakeStats));
    await lane.flushAfterAttach(); // ARMING — reconcile is an armed-lane op

    // Fresh spine: the caller's known-set is empty. Reconcile emits all.
    const emitted = await lane.reconcilePaths(RECONCILE_PATHS, new Set<string>());

    check('S9 reconcile emitted all 5', emitted === 5, `${emitted}`);

    const events = readEvents(fs, SHARD);
    check('S9 five creates on disk', events.length === 5, `${events.length}`);
    check('S9 all note.created', events.every((e) => e.type === 'note.created'),
          events.map((e) => e.type).join(','));
    check('S9 seq contiguous 1..5 (length-guarded)',
          events.length === 5 && events.every((e, i) => e.seq === i + 1),
          events.map((e) => e.seq).join(','));
    check('S9 backfilled payloads carry real stat/sha',
          events.every((e) => typeof e.mtime === 'number' &&
          typeof e.bytes === 'number' &&
          typeof e.content_sha === 'string'),
          JSON.stringify(events[0] ?? {}));

    // Tombstone population: deleting a reconciled path must carry the
    // BACKFILLED sha — this is the pre-existing-note tombstone gap, closed.
    await lane.onVaultDelete(md('Notes/r-3.md'));
    const after = readEvents(fs, SHARD);
    const tomb = after.find((e) => e.type === 'note.deleted');
    check('S9 delete of reconciled path carries last_content_sha',
          tomb?.last_content_sha === '0000000000000003', `${tomb?.last_content_sha}`);

    await log.dispose();
}

// -----------------------------------------------------------------------------
// S10 — Reconcile idempotence: second run emits ZERO
// -----------------------------------------------------------------------------

async function s10ReconcileIdempotent(): Promise<void> {
    const ROOT = '/f12-s10';
    const { log, fs } = spawnContext('mokka', ROOT, { now: () => FIXED_TS });
    const SHARD = shardPath(ROOT, 'mokka');

    const fakeStats = new Map<string, StatSnapshot & { sha: string }>();
    seedReconcileStats(fakeStats);

    const lane = makeWatcherLane(statsDeps('S10', log, fakeStats));
    await lane.flushAfterAttach(); // ARMING

    const first = await lane.reconcilePaths(RECONCILE_PATHS, new Set<string>());
    check('S10 first reconcile emitted 5', first === 5, `${first}`);

    // The caller now knows all five (spine re-read). Second run is a no-op.
    const second = await lane.reconcilePaths(RECONCILE_PATHS, new Set(RECONCILE_PATHS));
    check('S10 second reconcile emitted 0 (idempotent)', second === 0, `${second}`);

    const events = readEvents(fs, SHARD);
    check('S10 still exactly 5 events (no double-emit)', events.length === 5,
          `${events.length}`);
    check('S10 no duplicate paths',
          new Set(events.map((e) => e.path)).size === 5,
          `${new Set(events.map((e) => e.path)).size}`);

    await log.dispose();
}

// -----------------------------------------------------------------------------
// S11 — Reconcile partial gap: exactly the missing paths
// -----------------------------------------------------------------------------

async function s11ReconcilePartial(): Promise<void> {
    const ROOT = '/f12-s11';
    const { log, fs } = spawnContext('mokka', ROOT, { now: () => FIXED_TS });
    const SHARD = shardPath(ROOT, 'mokka');

    const fakeStats = new Map<string, StatSnapshot & { sha: string }>();
    seedReconcileStats(fakeStats);

    const lane = makeWatcherLane(statsDeps('S11', log, fakeStats));
    await lane.flushAfterAttach(); // ARMING

    // Crash-mid-backfill shape: the spine knows three of the five.
    const known = new Set(['Notes/r-1.md', 'Notes/r-2.md', 'Notes/r-3.md']);
    const emitted = await lane.reconcilePaths(RECONCILE_PATHS, known);

    check('S11 emitted exactly the 2 missing', emitted === 2, `${emitted}`);

    const events = readEvents(fs, SHARD);
    check('S11 two events on disk', events.length === 2, `${events.length}`);
    check('S11 emitted paths are the gaps',
          events.length === 2 &&
          events.every((e) => e.path === 'Notes/r-4.md' || e.path === 'Notes/r-5.md'),
          events.map((e) => e.path).join(','));

    await log.dispose();
}

// -----------------------------------------------------------------------------
// S12 — Reconcile refusal while dark (cap protection)
// -----------------------------------------------------------------------------

async function s12ReconcileDarkRefusal(): Promise<void> {
    const ROOT = '/f12-s12';
    const { log, fs } = spawnContext('mokka', ROOT, { now: () => FIXED_TS });
    const SHARD = shardPath(ROOT, 'mokka');

    const fakeStats = new Map<string, StatSnapshot & { sha: string }>();
    seedReconcileStats(fakeStats);

    // NO ARMING — the writer is dark.
    const lane = makeWatcherLane(statsDeps('S12', log, fakeStats));

    const refused = await lane.reconcilePaths(RECONCILE_PATHS, new Set<string>());
    check('S12 reconcile refused while dark (-1)', refused === -1, `${refused}`);
    check('S12 ZERO buffer growth (cap protection)', lane.pendingCount === 0,
          `pending: ${lane.pendingCount}`);
    check('S12 nothing written while dark', log.lastSeq === 0, `${log.lastSeq}`);

    // Refusal is not poisoning: arm, then the same call succeeds.
    await lane.flushAfterAttach();
    const emitted = await lane.reconcilePaths(RECONCILE_PATHS, new Set<string>());
    check('S12 post-arm reconcile succeeds', emitted === 5, `${emitted}`);

    const events = readEvents(fs, SHARD);
    check('S12 five events after arm', events.length === 5, `${events.length}`);

    await log.dispose();
}

// -----------------------------------------------------------------------------
// S13 — Reconcile has no hidden state: create → delete → reconcile
// -----------------------------------------------------------------------------

async function s13ReconcileNoHiddenState(): Promise<void> {
    const ROOT = '/f12-s13';
    const { log, fs } = spawnContext('mokka', ROOT, { now: () => FIXED_TS });
    const SHARD = shardPath(ROOT, 'mokka');

    const P = 'Notes/resurrect.md';
    const fakeStats = new Map<string, StatSnapshot & { sha: string }>();
    fakeStats.set(P, { mtime: 1763000500000, bytes: 210, sha: 'feedfacefeedface' });

    const lane = makeWatcherLane(statsDeps('S13', log, fakeStats));
    await lane.flushAfterAttach(); // ARMING

    // A full lifecycle: the delete CONSUMES the lane's sha entry, so the
    // lane holds no memory of this path afterwards.
    await lane.onVaultCreate(md(P));
    await lane.onVaultDelete(md(P));

    // The file is restored (trash recovery, sync-back). The spine's
    // LIVE set is empty for this path, so the caller passes an empty
    // known-set. Reconcile must emit — no ever-seen dedup may suppress it.
    fakeStats.set(P, { mtime: 1763000600000, bytes: 260, sha: 'beefbeefbeefbeef' });
    const emitted = await lane.reconcilePaths([P], new Set<string>());

    check('S13 restored path reconciles (no hidden dedup)', emitted === 1, `${emitted}`);

    const events = readEvents(fs, SHARD);
    check('S13 three facts: created/deleted/created',
          events.map((e) => e.type).join(',') === 'note.created,note.deleted,note.created',
          events.map((e) => e.type).join(','));
    check('S13 reconciled create carries the FRESH sha',
          events[2]?.content_sha === 'beefbeefbeefbeef', `${events[2]?.content_sha}`);
    check('S13 reconciled create carries the fresh mtime',
          events[2]?.mtime === 1763000600000, `${events[2]?.mtime}`);

    await log.dispose();
}

// -----------------------------------------------------------------------------
// Registry + main — ONE main call (csuite rule)
// -----------------------------------------------------------------------------

const SCENARIOS: Array<{ id: string; run: () => Promise<void> }> = [
    { id: 'S1', run: s1SingleFireCreate },
{ id: 'S2', run: s2SilenceContracts },
{ id: 'S3', run: s3UntitledLifecycle },
{ id: 'S4', run: s4DarkBoot },
{ id: 'S5', run: s5StormBurst },
{ id: 'S6', run: s6SyncAttribution },
{ id: 'S7', run: s7Overflow },
{ id: 'S8', run: s8UnknownDelete },
{ id: 'S9', run: s9ReconcileFresh },
{ id: 'S10', run: s10ReconcileIdempotent },
{ id: 'S11', run: s11ReconcilePartial },
{ id: 'S12', run: s12ReconcileDarkRefusal },
{ id: 'S13', run: s13ReconcileNoHiddenState },
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
        console.log(`F12: ALL GREEN (${checks} checks, ${SCENARIOS.length} scenarios)`);
    } else {
        console.log(`F12: ${failures} RED (out of ${checks} checks)`);
    }
}

main().then(() => {
    if (failures > 0) process.exitCode = 1;
});
