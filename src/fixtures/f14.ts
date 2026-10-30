// =============================================================================
// Vault Overseer — F14: Folder rename transcription
// src/fixtures/f14.ts
//
// Certifies the folder.renamed contract (Event Log Schema v0.2, designed
// 2026-10-24; corpus addendum rev. 2026-10-30):
//
//   R1  ONE event only — the mass-invalidation fact records as a single
//       folder.renamed line; no note.* child explosion.
//   R2  Tier-1 write-through: notification fires AFTER disk append —
//       the disk-at-callback witness (F13 S1 precedent).
//   R3  Planner rev B: cancelPrefix(from) kills pending modifies under
//       the old prefix BEFORE the spine fact lands (adapter ordering,
//       ruled 2026-10-30: cancel first, then emit). Boundary-discipline
//       in the planner itself: 'Projects/A' must not capture
//       'Projects/A 2/x.md' (gate.renamePrefix's rule, mirrored).
//   R4  Projection fold: live paths under from/ re-address to to/;
//       sibling prefixes untouched; dead-path tombstones KEEP their
//       death address (session ruling 2026-10-30 — history is not
//       rewritten by a later folder rename).
//   R5  Chained renames compose when replayed (A -> B -> C resolves
//       to the final address).
//
// FIRST-CONTACT LEDGER (corpus doctrine): 2026-10-30 — TBD. House-order
//   note, declared: implementation landed BEFORE this fixture (reverse
//   of the usual contract-then-red sequence). First contact therefore
//   tests contract-vs-implementation divergence; a red here names a
//   disagreement between the schema's contract text and the code, not
//   a missing behavior.
//
// TYPECHECK LEDGER (three rounds, honest):
//   Round 1 — payload shapes guessed, not read: discriminated-union
//     cast at the wrong boundary; invented 'content_sha' on note.deleted.
//   Round 2 — compiler receipts applied but still not grounded: tried
//     to cast Record<string,unknown> to NoteModifiedPayload directly
//     (TS2352: the types do not overlap — correctly), and learned
//     note.deleted requires last_content_sha (types.ts:108).
//   Round 3 (this) — types.ts PASTED IN FULL and read. All payload
//     shapes now transcribed from the actual definitions. The R3
//     fake-dep boundary RECONSTRUCTS the typed payload field-by-field
//     from the planner's loose Record — cast-free, and the field list
//     doubles as executable documentation of NoteModifiedPayload's
//     canon: path, mtime, bytes, content_sha.
//
// Idiom: spawnContext + FakeAdapter (spine fixtures) — harness rules
//   1-4 apply: public API only (appendEvent, subscribe, dispose, the
//   planner's own lane surface), corruption nowhere, fixed clock,
//   deterministic thresholds. R3 drives the REAL makePlanner (pure
//   module) with fake deps — the main.ts adapter is Obsidian-bound and
//   out of Node's reach, so the ruled ORDERING (cancelPrefix then
//   emission) is reproduced here exactly as main.ts performs it.
//
// ASYNC DISCIPLINE (csuite rule): ONE main call, every await spelled
//   out, no IIFE scaffolding.
//
// Run:  node ./src/fixtures/f14.ts
// Node note: erasable TS, .ts import extensions.
// =============================================================================

import { spawnContext, shardPath } from '../test-harness.ts';
import { mergeScan } from '../eventlog/reader.ts';
import { projectPaths } from '../eventlog/projection.ts';
import { makePlanner } from '../planner/planner.ts';

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

const FIXED_TS = '2026-10-30T09:00:00+00:00';

function readEvents(
    fs: { read(p: string): string | undefined },
                    shard: string,
): Array<Record<string, unknown>> {
    return (fs.read(shard) ?? '')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// -----------------------------------------------------------------------------
// R1 — One event only, subscriber notified
// -----------------------------------------------------------------------------

async function r1SingleEvent(): Promise<void> {
    const ROOT = '/f14-r1';
    const { log, fs } = spawnContext('mokka', ROOT, {
        now: () => FIXED_TS,
                                     settings: { tier2FlushCount: 64, tier2IdleMs: 60_000 },
    });
    const SHARD = shardPath(ROOT, 'mokka');

    // Seed a subtree so the rename has something to invalidate.
    await log.appendEvent('user', 'note.created', {
        path: 'Projects/A/one.md',
        mtime: 1763000000000,
        bytes: 100,
        content_sha: 'aaaa0001aaaa0001',
    });
    await log.appendEvent('user', 'note.created', {
        path: 'Projects/A/sub/two.md',
        mtime: 1763000000001,
        bytes: 110,
        content_sha: 'aaaa0002aaaa0002',
    });

    const seen: string[] = [];
    log.subscribe('r1-witness', (e) => seen.push(e.type));

    await log.appendEvent('user', 'folder.renamed', { from: 'Projects/A', to: 'Projects/C' });

    check('R1 subscriber received the folder.renamed', seen.includes('folder.renamed'),
          seen.join(','));

    const events = readEvents(fs, SHARD);
    const folderRenames = events.filter((e) => e.type === 'folder.renamed');
    check('R1 exactly one folder.renamed on disk', folderRenames.length === 1,
          `${folderRenames.length}`);

    // The O(1)-recording contract: the rename may not transcribe as child
    // note.* events. (Tier-1 write-through lands it immediately — no
    // buffering lane could hide an explosion behind a flush.)
    const childExplosions = events.filter(
        (e) => typeof e.type === 'string' && e.type.startsWith('note.') &&
        e.type !== 'note.created', // the two seeds above are expected
    );
    check('R1 no child note.* emissions for the renamed subtree',
          childExplosions.length === 0,
          childExplosions.map((e) => `${e.type}:${e.path}`).join(','));

    await log.dispose();
}

// -----------------------------------------------------------------------------
// R2 — Notification AFTER disk append (F13's persistence-latency witness)
// -----------------------------------------------------------------------------

async function r2NotificationAfterDiskAppend(): Promise<void> {
    const ROOT = '/f14-r2';
    const { log, fs } = spawnContext('mokka', ROOT, {
        now: () => FIXED_TS,
                                     settings: { tier2FlushCount: 64, tier2IdleMs: 60_000 },
    });
    const SHARD = shardPath(ROOT, 'mokka');

    let cbSeq: number | null = null;
    let onDiskAtCallback = false;
    log.subscribe('r2-witness', (e) => {
        if (e.type !== 'folder.renamed') return;
        cbSeq = e.seq as number;
        // DISK-AT-CALLBACK WITNESS: the notified event's own line must
        // already be on disk when the callback runs.
        onDiskAtCallback = readEvents(fs, SHARD).some((ev) => ev.seq === cbSeq);
    });

    await log.appendEvent('user', 'folder.renamed', { from: 'Projects/A', to: 'Projects/C' });

    check('R2 subscriber notified', cbSeq !== null, `${cbSeq}`);
    check('R2 callback saw its own line on disk', onDiskAtCallback, `${cbSeq}`);

    await log.dispose();
}

// -----------------------------------------------------------------------------
// R3 — Planner rev B: cancelPrefix before the fact, boundary discipline
// -----------------------------------------------------------------------------

async function r3PlannerCancelPrefix(): Promise<void> {
    const ROOT = '/f14-r3';
    const { log, adapter, fs } = spawnContext('mokka', ROOT, {
        now: () => FIXED_TS,
                                              settings: { tier2FlushCount: 64, tier2IdleMs: 60_000 },
    });
    const SHARD = shardPath(ROOT, 'mokka');

    // Seed live paths: two under the doomed prefix, one sibling, one
    // boundary sibling (the prefix trap: 'Projects/A' vs 'Projects/A 2').
    await log.appendEvent('user', 'note.created', {
        path: 'Projects/A/one.md', mtime: 1000, bytes: 10, content_sha: 'aaaa0001aaaa0001',
    });
    await log.appendEvent('user', 'note.created', {
        path: 'Projects/A/two.md', mtime: 1010, bytes: 12, content_sha: 'aaaa0002aaaa0022',
    });
    await log.appendEvent('user', 'note.created', {
        path: 'Projects/B/stays.md', mtime: 1020, bytes: 14, content_sha: 'aaaa0003aaaa0033',
    });
    await log.appendEvent('user', 'note.created', {
        path: 'Projects/A 2/boundary.md', mtime: 1030, bytes: 16, content_sha: 'aaaa0004aaaa0044',
    });

    // The REAL planner lane, manual-flush (no scheduler — determinism).
    // Stats/sha differ from every seed, so an uncancelled pending WOULD
    // emit: the cancel is the only thing standing between the pending
    // and a stale-address emission.
    //
    // The fake appendEvent dep RECONSTRUCTS the typed payload from the
    // planner's loose Record — field-by-field, cast-free, matching
    // NoteModifiedPayload's canon (path, mtime, bytes, content_sha).
    // The planner constructs exactly this shape at its call site; the
    // reconstruction makes the fixture readable as documentation of
    // both sides of the boundary.
    const planner = makePlanner(
        {
            stat: async () => ({ mtime: 5000, bytes: 50 }),
                                contentSha: async () => 'bbbb1111bbbb1111',
                                appendEvent: async (_actor, _type, p) => {
                                    await log.appendEvent('user', 'note.modified', {
                                        path: String(p.path),
                                                          mtime: Number(p.mtime),
                                                          bytes: Number(p.bytes),
                                                          content_sha: String(p.content_sha),
                                    });
                                },
        },
        { source: adapter, eventsDir: '_vault-index/events' },
    );

    planner.arm();
    await planner.onVaultModify({ path: 'Projects/A/one.md', isFolder: false, ext: 'md' });
    await planner.onVaultModify({ path: 'Projects/A/two.md', isFolder: false, ext: 'md' });
    await planner.onVaultModify({ path: 'Projects/A 2/boundary.md', isFolder: false, ext: 'md' });
    await planner.onVaultModify({ path: 'Projects/B/stays.md', isFolder: false, ext: 'md' });
    check('R3 four observations pending', planner.pendingCount === 4, `${planner.pendingCount}`);

    // ADAPTER ORDERING (ruled 2026-10-30), reproduced exactly as
    // main.ts performs it: cancelPrefix FIRST, then the spine fact.
    const killed = planner.cancelPrefix('Projects/A');
    check('R3 cancelPrefix killed exactly the two under-prefix pendings',
          killed === 2, `${killed}`);
    check('R3 boundary sibling survived the cancel',
          planner.pendingCount === 2, `${planner.pendingCount}`);

    await log.appendEvent('user', 'folder.renamed', { from: 'Projects/A', to: 'Projects/C' });

    const result = await planner.flush();
    check('R3 flush emitted only the surviving pendings', result.emitted === 2,
          `emitted=${result.emitted} suppressed=${result.suppressed}`);
    check('R3 flush refused nothing (spine contiguous)', result.refused === false);

    // The spine's verdict: no note.modified may name a stale address.
    const events = readEvents(fs, SHARD);
    const modifiedPaths = events
    .filter((e) => e.type === 'note.modified')
    .map((e) => String(e.path));
    check('R3 no note.modified against the stale prefix',
          modifiedPaths.every((p) => !p.startsWith('Projects/A/')),
          modifiedPaths.join(','));

    // Ordering witness: the folder.renamed line precedes the post-cancel
    // flush emissions — pending state died BEFORE the fact landed.
    const frSeq = events.find((e) => e.type === 'folder.renamed')?.seq as number;
    const modSeqs = events
    .filter((e) => e.type === 'note.modified')
    .map((e) => e.seq as number);
    check('R3 folder.renamed precedes the post-cancel flush emissions',
          modSeqs.every((s) => s > frSeq),
          `fr=${frSeq} mods=${modSeqs.join(',')}`);

    await log.dispose();
}

// -----------------------------------------------------------------------------
// R4 — Projection fold: movement, boundary discipline, tombstone ruling
// -----------------------------------------------------------------------------

async function r4ProjectionFold(): Promise<void> {
    const ROOT = '/f14-r4';
    const { log, adapter } = spawnContext('mokka', ROOT, {
        now: () => FIXED_TS,
                                          settings: { tier2FlushCount: 64, tier2IdleMs: 60_000 },
    });

    const seed = (path: string, n: number) =>
    log.appendEvent('user', 'note.created', {
        path, mtime: 1763000000000 + n, bytes: 100 + n,
        content_sha: `aaaa000${n}aaaa000${n}`,
    });

    await seed('Area/in.md', 1);
    await seed('Area/sub/deep.md', 2);
    await seed('Area 2/sibling.md', 3);
    await seed('Areas/cousin.md', 4);
    await seed('Area/tomb.md', 5);
    // A path that DIES before the rename — its tombstone must keep the
    // death address (history is not rewritten; session ruling 2026-10-30).
    // NoteDeletedPayload (types.ts): { path, last_content_sha } — the
    // tombstone carries the sha it died with.
    await log.appendEvent('user', 'note.deleted', {
        path: 'Area/tomb.md',
        last_content_sha: 'aaaa0005aaaa0005',
    });

    await log.appendEvent('user', 'folder.renamed', { from: 'Area', to: 'Region' });

    const scan = await mergeScan(adapter, '_vault-index/events');
    const proj = projectPaths(scan.events);

    check('R4 in-prefix paths re-addressed to Region/',
          proj.livePaths.has('Region/in.md') && proj.livePaths.has('Region/sub/deep.md'),
          Array.from(proj.livePaths).join(','));
    check('R4 old addresses vacated',
          !proj.livePaths.has('Area/in.md') && !proj.livePaths.has('Area/sub/deep.md'),
          Array.from(proj.livePaths).join(','));
    check("R4 'Area 2/' untouched (boundary: 'Area' never captures it)",
          proj.livePaths.has('Area 2/sibling.md'),
          Array.from(proj.livePaths).join(','));
    check("R4 'Areas/' untouched",
          proj.livePaths.has('Areas/cousin.md'),
          Array.from(proj.livePaths).join(','));
    check('R4 dead-path tombstone keeps its death address',
          proj.deadPaths.has('Area/tomb.md') && !proj.deadPaths.has('Region/tomb.md'),
          Array.from(proj.deadPaths).join(','));

    await log.dispose();
}

// -----------------------------------------------------------------------------
// R5 — Chained renames compose (A -> B -> C resolves to the final address)
// -----------------------------------------------------------------------------

async function r5ChainedRenames(): Promise<void> {
    const ROOT = '/f14-r5';
    const { log, adapter, fs } = spawnContext('mokka', ROOT, {
        now: () => FIXED_TS,
                                              settings: { tier2FlushCount: 64, tier2IdleMs: 60_000 },
    });
    const SHARD = shardPath(ROOT, 'mokka');

    await log.appendEvent('user', 'note.created', {
        path: 'Work/task.md', mtime: 1763000000000, bytes: 100,
        content_sha: 'aaaa0001aaaa0001',
    });

    await log.appendEvent('user', 'folder.renamed', { from: 'Work', to: 'Projects' });

    // A create at the intermediate address, after the first rename:
    // it must survive the second rename by ordinary prefix folding.
    await log.appendEvent('user', 'note.created', {
        path: 'Projects/new.md', mtime: 1763000000001, bytes: 120,
        content_sha: 'aaaa0002aaaa0002',
    });

    await log.appendEvent('user', 'folder.renamed', { from: 'Projects', to: 'Archive' });

    const scan = await mergeScan(adapter, '_vault-index/events');
    const proj = projectPaths(scan.events);

    check('R5 chained rename resolves to the final address',
          proj.livePaths.has('Archive/task.md') && proj.livePaths.has('Archive/new.md'),
          Array.from(proj.livePaths).join(','));
    check('R5 intermediate and original addresses vacated',
          !proj.livePaths.has('Work/task.md') && !proj.livePaths.has('Projects/task.md') &&
          !proj.livePaths.has('Projects/new.md'),
          Array.from(proj.livePaths).join(','));

    const folderRenames = readEvents(fs, SHARD).filter((e) => e.type === 'folder.renamed');
    check('R5 two folder.renamed events recorded (one per rename, O(1) each)',
          folderRenames.length === 2, `${folderRenames.length}`);

    await log.dispose();
}

// -----------------------------------------------------------------------------
// Registry + main — ONE main call (csuite rule)
// -----------------------------------------------------------------------------

const SCENARIOS: Array<{ id: string; run: () => Promise<void> }> = [
    { id: 'R1', run: r1SingleEvent },
{ id: 'R2', run: r2NotificationAfterDiskAppend },
{ id: 'R3', run: r3PlannerCancelPrefix },
{ id: 'R4', run: r4ProjectionFold },
{ id: 'R5', run: r5ChainedRenames },
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
        console.log(`F14: ALL GREEN (${checks} checks, ${SCENARIOS.length} scenarios)`);
    } else {
        console.log(`F14: ${failures} RED (out of ${checks} checks)`);
    }
}

main().then(() => {
    if (failures > 0) process.exitCode = 1;
});
