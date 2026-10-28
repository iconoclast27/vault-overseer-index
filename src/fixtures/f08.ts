// =============================================================================
// Vault Overseer — Fixture F08: No-Op Modification Dedup
// src/fixtures/f08.ts
//
// Contract basis (authored from CONTRACT TEXT, not observed behavior):
//   - Event Log Schema v0.2, note.modified catalog note: "same sha + mtime
//     => no event, no seq consumed."
//   - Contrapositive ratified 2026-10-28: EITHER differing => emit
//     (a touch — same sha, new mtime — is a judgment-weight fact).
//   - Planner Lane header (planner.ts rev A, 2026-10-28): coalescing
//     last-wins per path; cancel-on-delete; cancel-on-rename; unknown
//     path => routeCreate; dead path => routeRestore; seq gap => refuse
//     loudly and drop pending; pre-arm observations dropped (Q3).
//
// Idiom: direct-drive the planner lane (F05a/F09 tradition) — pure module,
// injected deps, deterministic inputs, no vault dependency.
//
// WHY ZERO CALLS PROVES ZERO SEQ: the writer allocates seq per append
// (smoke.ts receipt: 5 appends => seq 1..5 contiguous). The planner's
// suppression path never calls appendEvent, therefore no seq is allocated.
// The appendEvent dep here is a spy: it records calls and writes nothing.
//
// Shard preparation is the F01/F02 corpus idiom: hand-crafted JSONL on
// disk, envelope keys in normative order, payload fields FLATTENED onto
// the envelope — confirmed correct against reader.ts (pasted 2026-10-28),
// which JSON.parses whole lines into ParsedLine = Record<string, unknown>.
//
// RESOLVED ASSUMPTION (was #1, disproven then fixed by receipt):
//   ByteSource is { readBinary(path), listDir(path) } — reader.ts:166-171.
//   mergeScan discovers shards via listDir(eventsDir), filters *.jsonl,
//   then readBinary(`${eventsDir}/${name}`). makeSpineSource implements
//   both, against the real interface, no cast.
//
// DEFERRED (not silently dropped): the real-writer continuity probe —
// appending through a live EventLog and reading the shard tail for the
// seq+1 landing — needs test-harness.ts's exact spawnContext/fs contract
// pasted before it can be written against receipts rather than guesses.
//
// Run:  node src/fixtures/f08.ts
// Exit: 0 = all green, 1 = at least one red
// =============================================================================

import {
    makePlanner,
    type PlannerDeps,
    type PlannerContext,
} from '../planner/planner.ts';
import type { FileLike } from '../watcher/watch.ts';
import type { ByteSource } from '../eventlog/reader.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// -----------------------------------------------------------------------------
// Shard crafting — F01/F02 idiom
// -----------------------------------------------------------------------------

/** Envelope key order is NORMATIVE (types.ts): v, seq, ts, origin, actor, type, then payload. */
function created(
    seq: number,
    p: string,
    mtime: number,
    bytes: number,
    sha: string,
): Record<string, unknown> {
    return {
        v: 1, seq,
        ts: '2026-10-28T10:00:00+01:00',
        origin: 'mokka', actor: 'user', type: 'note.created',
        path: p, mtime, bytes, content_sha: sha,
    };
}

function deleted(seq: number, p: string, sha: string): Record<string, unknown> {
    return {
        v: 1, seq,
        ts: '2026-10-28T10:00:00+01:00',
        origin: 'mokka', actor: 'user', type: 'note.deleted',
        path: p, last_content_sha: sha,
    };
}

// -----------------------------------------------------------------------------
// Spy harness — controlled observations
// -----------------------------------------------------------------------------

interface AppendCall {
    readonly actor: 'user';
    readonly type: 'note.modified';
    readonly payload: Record<string, unknown>;
}

interface Override {
    readonly mtime: number;
    readonly bytes: number;
    readonly sha: string;
}

/**
 * Observation control: stat/contentSha consult the override map first.
 * Defaults NEVER match any spine record (mtime 1 / dummy sha) — an
 * accidental no-op is impossible; no-ops must be constructed on purpose.
 */
class PlannerSpy {
    readonly calls: AppendCall[] = [];
    readonly integrity: string[] = [];
    readonly routedCreate: string[] = [];
    readonly routedRestore: string[] = [];
    private readonly overrides = new Map<string, Override>();

    reset(): void {
        this.calls.length = 0;
        this.routedCreate.length = 0;
        this.routedRestore.length = 0;
        // integrity log is CUMULATIVE across scenarios — disclosures
        // accumulate like they would on a real spine.
    }

    override(p: string, mtime: number, bytes: number, sha: string): void {
        this.overrides.set(p, { mtime, bytes, sha });
    }

    get modifiedCount(): number {
        return this.calls.length;
    }

    /** Most recent note.modified payload, or undefined. */
    get lastPayload(): Record<string, unknown> | undefined {
        return this.calls.length > 0 ? this.calls[this.calls.length - 1].payload : undefined;
    }

    deps(withRoutes = true): PlannerDeps {
        const spy = this;
        const base: PlannerDeps = {
            stat: async (p) => {
                const o = spy.overrides.get(p);
                return o !== undefined ? { mtime: o.mtime, bytes: o.bytes } : { mtime: 1, bytes: 1 };
            },
            contentSha: async (p) => {
                const o = spy.overrides.get(p);
                return o !== undefined ? o.sha : '0f0f0f0f0f0f0f0f';
            },
            appendEvent: async (actor, type, payload) => {
                spy.calls.push({ actor, type, payload });
            },
            reportIntegrity: async (detail) => {
                spy.integrity.push(detail);
            },
        };
        if (!withRoutes) return base;
        return {
            ...base,
            routeCreate: async (p) => { spy.routedCreate.push(p); },
            routeRestore: async (p) => { spy.routedRestore.push(p); },
        };
    }
}

/**
 * The fake spine source — implements the REAL ByteSource interface
 * (reader.ts): readBinary(path) + listDir(path). Reads actual files from
 * eventsDir, so mergeScan's discovery path is exercised faithfully.
 */
function makeSpineSource(eventsDir: string): ByteSource {
    return {
        async readBinary(p: string): Promise<Uint8Array | undefined> {
            // mergeScan calls readBinary(`${eventsDir}/${name}`) — a full
            // path. Fall back to basename-in-eventsDir for tolerance.
            for (const candidate of [p, path.join(eventsDir, path.basename(p))]) {
                if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                    return fs.readFileSync(candidate);
                }
            }
            return undefined;
        },
        async listDir(dir: string): Promise<string[]> {
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir);
        },
    };
}

// -----------------------------------------------------------------------------
// Checks
// -----------------------------------------------------------------------------

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
    if (ok) {
        console.log(`[PASS] ${name}`);
    } else {
        failures++;
        console.log(`[FAIL] ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
    }
}

const file = (p: string): FileLike => ({ path: p, isFolder: false, ext: 'md' });

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
    const M = 1763000000000;

    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'f08-'));
    try {
        const eventsDir = path.join(tmpdir, 'events');
        fs.mkdirSync(eventsDir, { recursive: true });
        const shardFile = path.join(eventsDir, 'mokka.jsonl');

        const writeSpine = (events: Record<string, unknown>[]): void => {
            fs.writeFileSync(shardFile, events.map((e) => JSON.stringify(e) + '\n').join(''));
        };

        const ctx: PlannerContext = {
            source: makeSpineSource(eventsDir),
            eventsDir,
        };

        const spy = new PlannerSpy();

        // A live spine of three known paths with recorded state.
        const baseSpine: Record<string, unknown>[] = [
            created(1, 'Notes/a.md', M, 1000, 'aaaa0000aaaa0000'),
            created(2, 'Notes/b.md', M + 1000, 1100, 'bbbb0000bbbb0000'),
            created(3, 'Notes/c.md', M + 2000, 1200, 'cccc0000cccc0000'),
        ];
        writeSpine(baseSpine);

        const planner = makePlanner(spy.deps(), ctx);
        planner.arm();

        // =====================================================================
        // S0 — pre-arm observation dropped (Q3 ruling: heal is the cover)
        // =====================================================================
        const dark = makePlanner(spy.deps(), ctx); // never armed
        await dark.onVaultModify(file('Notes/dark.md'));
        check('S0: pre-arm modify dropped — dark lane empty, heal covers',
              dark.pendingCount === 0, `pending: ${dark.pendingCount}`);

        // =====================================================================
        // S1 — THE no-op: same sha + mtime => zero events, zero seq consumed
        // Proof: zero appendEvent CALLS. The writer allocates seq per append
        // (smoke.ts: 5 appends => seq 1..5), so a spy never asked cannot
        // consume a seq. Shard bytes compared as a belt-and-braces witness.
        // =====================================================================
        const shardBefore = fs.readFileSync(shardFile, 'utf8');
        spy.override('Notes/a.md', M, 1000, 'aaaa0000aaaa0000'); // EXACT spine state

        await planner.onVaultModify(file('Notes/a.md'));
        const r1 = await planner.flush();

        check('S1: no-op suppressed (suppressed = 1, emitted = 0)',
              r1.suppressed === 1 && r1.emitted === 0,
              `suppressed: ${r1.suppressed}, emitted: ${r1.emitted}`);
        check('S1: zero appendEvent calls — the writer was never asked',
              spy.calls.length === 0, `calls: ${spy.calls.length}`);
        check('S1: shard bytes untouched by the no-op flush',
              fs.readFileSync(shardFile, 'utf8') === shardBefore);

        // =====================================================================
        // S2 — touch: same sha, NEW mtime => EMITS (contrapositive ruling)
        // =====================================================================
        spy.reset();
        spy.override('Notes/a.md', M + 5000, 1000, 'aaaa0000aaaa0000');

        await planner.onVaultModify(file('Notes/a.md'));
        const r2 = await planner.flush();

        const p2 = spy.lastPayload;
        check('S2: touch emits (same sha, new mtime)',
              r2.emitted === 1 && spy.modifiedCount === 1,
              `emitted: ${r2.emitted}, suppressed: ${r2.suppressed}`);
        check('S2: payload carries observation-time stats in schema order',
              p2 !== undefined &&
              p2.path === 'Notes/a.md' && p2.mtime === M + 5000 &&
              p2.bytes === 1000 && p2.content_sha === 'aaaa0000aaaa0000',
              `payload: ${JSON.stringify(p2)}`);

        // =====================================================================
        // S3 — genuine modify: different sha => EMITS
        // =====================================================================
        spy.reset();
        spy.override('Notes/b.md', M + 6000, 1150, 'bbbb1111bbbb1111');

        await planner.onVaultModify(file('Notes/b.md'));
        const r3 = await planner.flush();

        const p3 = spy.lastPayload;
        check('S3: genuine modify emits',
              r3.emitted === 1 && spy.modifiedCount === 1,
              `emitted: ${r3.emitted}, suppressed: ${r3.suppressed}`);
        check('S3: payload names the new content',
              p3 !== undefined && p3.content_sha === 'bbbb1111bbbb1111',
              `payload: ${JSON.stringify(p3)}`);

        // =====================================================================
        // S4 — coalescing: two observations, one path => last-wins, ONE event
        // =====================================================================
        spy.reset();
        spy.override('Notes/b.md', M + 7000, 1160, 'bbbb2222bbbb2222');
        await planner.onVaultModify(file('Notes/b.md'));
        spy.override('Notes/b.md', M + 8000, 1170, 'bbbb3333bbbb3333');
        await planner.onVaultModify(file('Notes/b.md'));

        check('S4a: coalesced to one pending observation',
              planner.pendingCount === 1, `pending: ${planner.pendingCount}`);

        const r4 = await planner.flush();
        const p4 = spy.lastPayload;
        check('S4b: exactly one emission for the storm',
              r4.emitted === 1 && spy.modifiedCount === 1,
              `emitted: ${r4.emitted}`);
        check('S4c: last observation wins (newest stats travel)',
              p4 !== undefined && p4.content_sha === 'bbbb3333bbbb3333' &&
              p4.mtime === M + 8000 && p4.bytes === 1170,
              `payload: ${JSON.stringify(p4)}`);

        // =====================================================================
        // S5 — unknown path => routeCreate, never a bare modify
        // =====================================================================
        spy.reset();
        await planner.onVaultModify(file('Notes/never-seen.md'));
        const r5 = await planner.flush();

        check('S5: unknown path routed to create lane',
              r5.routedCreate === 1 && spy.routedCreate[0] === 'Notes/never-seen.md',
              `routed: ${JSON.stringify(spy.routedCreate)}`);
        check('S5: unknown path produced no modify, no restore',
              r5.emitted === 0 && r5.routedRestore === 0 && spy.modifiedCount === 0,
              `emitted: ${r5.emitted}, restore: ${r5.routedRestore}`);

        // =====================================================================
        // S6 — spine-dead path => routeRestore (reconcile's ruling)
        // =====================================================================
        writeSpine([
            ...baseSpine,
            deleted(4, 'Notes/c.md', 'cccc0000cccc0000'),
        ]);
        spy.reset();
        spy.override('Notes/c.md', M + 9000, 1200, 'cccc1111cccc1111');
        await planner.onVaultModify(file('Notes/c.md'));
        const r6 = await planner.flush();

        check('S6: dead path routed to reconcile',
              r6.routedRestore === 1 && spy.routedRestore[0] === 'Notes/c.md',
              `routed: ${JSON.stringify(spy.routedRestore)}`);
        check('S6: dead path produced no modify, no create',
              r6.emitted === 0 && r6.routedCreate === 0 && spy.modifiedCount === 0,
              `emitted: ${r6.emitted}, create: ${r6.routedCreate}`);

        // =====================================================================
        // S7 — cancellation: delete kills the pending modify (tombstone wins)
        // =====================================================================
        writeSpine([created(1, 'Notes/z.md', M, 1000, 'zzzz0000zzzz0000')]);
        spy.reset();
        spy.override('Notes/z.md', M + 100, 1010, 'zzzz1111zzzz1111'); // WOULD emit if flushed
        await planner.onVaultModify(file('Notes/z.md'));

        check('S7a: modify observed and held pending',
              planner.pendingCount === 1, `pending: ${planner.pendingCount}`);

        planner.cancelPending('Notes/z.md');
        check('S7b: delete cancels pending (tombstone wins)',
              planner.pendingCount === 0, `pending: ${planner.pendingCount}`);

        const r7 = await planner.flush();
        check('S7c: flush after delete-cancel asks the writer nothing',
              r7.emitted === 0 && spy.calls.length === 0,
              `emitted: ${r7.emitted}, calls: ${spy.calls.length}`);

        // =====================================================================
        // S8 — cancellation: rename kills the pending modify (rename ⊂ modify)
        // =====================================================================
        spy.reset();
        await planner.onVaultModify(file('Notes/y.md')); // would route-create if flushed
        check('S8a: pending observed pre-cancel',
              planner.pendingCount === 1, `pending: ${planner.pendingCount}`);

        planner.cancelPending('Notes/y.md');
        const r8 = await planner.flush();
        check('S8b: rename cancels pending — nothing emitted, nothing routed',
              r8.emitted === 0 && spy.calls.length === 0 &&
              spy.routedCreate.length === 0 && spy.routedRestore.length === 0,
              `emitted: ${r8.emitted}, calls: ${spy.calls.length}`);

        // =====================================================================
        // S9 — seq gap: refuse loudly, drop pending, disclose
        // =====================================================================
        writeSpine([
            created(1, 'Notes/x.md', M, 1000, 'xxxx0000xxxx0000'),
                   created(3, 'Notes/x2.md', M, 1000, 'xxxx0002xxxx0000'), // seq 2 is a HOLE
        ]);
        spy.reset();
        spy.override('Notes/x.md', M + 100, 1010, 'xxxx1111xxxx1111'); // would emit
        await planner.onVaultModify(file('Notes/x.md'));

        const r9 = await planner.flush();

        check('S9a: flush refused across the gap',
              r9.refused === true, `refused: ${r9.refused}`);
        check('S9b: nothing emitted onto a broken spine',
              r9.emitted === 0 && spy.calls.length === 0,
              `emitted: ${r9.emitted}, calls: ${spy.calls.length}`);
        check('S9c: refusal disclosed through the integrity lane',
              spy.integrity.some((d) => d.includes('planner refused')),
              `integrity lines: ${spy.integrity.length}`);
        check('S9d: pending dropped on refusal, not retained',
              planner.pendingCount === 0, `pending: ${planner.pendingCount}`);

        // =====================================================================
        // S10 — unwired routing hooks disclose loudly (no silent drops)
        // NOTE: S9 left a GAPPED spine on disk. Rewrite a clean one first —
        // otherwise this flush refuses on the gap and never reaches the
        // routing loop, failing for a fixture reason instead of the real one.
        // =====================================================================
        writeSpine(baseSpine);
        spy.reset();
        const bare = makePlanner(spy.deps(false), ctx); // no routeCreate/routeRestore wired
        bare.arm();
        await bare.onVaultModify(file('Notes/orphan.md'));
        const r10 = await bare.flush();

        check('S10: unwired route hooks disclose instead of dropping silently',
              spy.integrity.some((d) => d.includes('routeCreate unwired')) &&
              r10.emitted === 0 && r10.refused === false,
              `emitted: ${r10.emitted}, refused: ${r10.refused}, ` +
              `integrity: ${spy.integrity.length}`);

        // ---------------------------------------------------------------------
        console.log('');
        if (failures === 0) {
            console.log('F08: ALL GREEN — no-op dedup contract survives the fixture.');
        } else {
            console.log(`F08: ${failures} red — the no-op dedup has defects.`);
        }
    } finally {
        fs.rmSync(tmpdir, { recursive: true, force: true });
    }
}

main().then(() => process.exit(failures === 0 ? 0 : 1));
