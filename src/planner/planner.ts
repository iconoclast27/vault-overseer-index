// =============================================================================
// Vault Overseer — Planner Lane (note.modified producer, increment 1)
// src/planner/planner.ts
//
// rev A (2026-10-28) — detection + emission + dedup only. Scope per session
// rulings 2026-10-28 (option (b): contract decided before fixture; F08 is
// authored from the CONTRACT TEXT, not from this implementation's observed
// behavior, and comes after this code is verified).
//
//   - State basis: SPINE TRUTH AT FLUSH TIME. One mergeScan + a path-state
//     fold per coalesced flush; no private cache, no in-memory drift. The
//     subscriber seam (frontier item 2) later makes this incremental;
//     building a cache now would be a hand-rolled mini-subscriber — that
//     lane's job, not this one's. (Session ruling Q1/Q2, 2026-10-28.)
//   - Decision rule, LITERAL schema reading (Event Log Schema v0.2, event
//     catalog): same sha + mtime => NO event, NO seq consumed. Contrapositive
//     ratified this session: EITHER differing => emit. A touch (mtime bumped,
//     sha identical) EMITS — judgment-weight fact, bounded by coalescing.
//     Never suppress on doubt: a path with live status but incomplete
//     recorded state emits rather than suppresses — suppressing loses a
//     fact, emitting costs one line.
//   - Coalescing (Q4, ratified): by path, LAST-OBSERVATION-WINS, inside the
//     debounce window. Cancellation rules (ratified):
//       * note.deleted for a path cancels its pending modify (tombstone wins)
//       * note.renamed for a path cancels its pending modify — rename is
//         semantically a modify subclass; the rename's own post-rename sha
//         check covers content drift (session ruling 2026-10-28)
//       * folder.renamed cancels every pending modify under the old prefix
//         (rev B below) — mass-invalidation supersedes individually
//         observed modifications at those now-dead addresses
//       * a modify for a path UNKNOWN to the spine routes to the create
//         lane (routeCreate) — never a bare modify resurrecting from nowhere
//       * a modify for a path the spine says is DEAD routes to reconcile
//         (routeRestore) — restored-file divergence is reconcile's ruling
//         per projection.ts's out-of-scope note, not improvised here
//   - Debounce ownership (Q2, ratified): THE PLANNER OWNS IT, modify lane
//     only. Create/delete are facts that never wait (Tier 1's "no loss
//     tolerated" is a crash-window contract — a debounce window holding a
//     fact is an undisclosed loss window). Only modifications are noisy AND
//     healable, so only they wait.
//   - Gap refusal (ratified): a seq gap refuses emission, loudly, mirroring
//     healScan's precedent — emitting into a spine known to be incomplete
//     fabricates a record. Pending observations are DROPPED on refusal:
//     the loss is heal-covered (F03's regime — mtime/sha drift from last
//     indexed is re-derivable at boot), and retaining observation-time
//     stats indefinitely risks emitting stale facts later.
//   - Overflow: pending map capped (default 500, dark-buffer precedent),
//     OLDEST pending dropped, disclosed at flush through reportIntegrity.
//     Dropping without an integrity lane wired is a declared limit — the
//     disclosure hook exists precisely so main.ts can wire it.
//
// rev B (2026-10-30) — F14: cancelPrefix. Closes the stale-pending gap
//   registered in main.ts's header (slot-4 wiring): a pending modify
//   observed under a folder's old prefix previously SURVIVED a folder
//   rename and flushed against a stale storage address. Session rulings
//   2026-10-30, in force:
//     - Signature: cancelPrefix(from) — the DESTINATION is not a parameter.
//       Pending observations DIE with the address; they do not migrate.
//       Rationale: stock Obsidian emits no child modify events on a folder
//       rename, so there is no fresh observation at the new address to
//       re-key to — synthesizing one would fabricate an observation the
//       vault never produced. Coverage for the renamed subtree is heal's
//       regime (mtime/sha drift from last indexed re-derives at boot),
//       exactly the crash-window limitation's recovery path, already
//       ratified in rev A.
//     - The method RETURNS the cancelled count: quiet in the spine (the
//       cancelling folder.renamed event IS the record — no integrity line,
//       no second event), but countable, so the F14 fixture asserts
//       cancellation through the public API without violating corpus
//       rule 1 (no reaching into internals; if a test needs an internal,
//       the internal is really a public).
//     - Ordering (ruled): the adapter calls cancelPrefix BEFORE the
//       folder.renamed emission — pending state dies before the fact
//       lands. No window exists in which the folder.renamed line is on
//       the spine while a stale-addressed observation still sits pending.
//     - Boundary discipline mirrors gate.renamePrefix exactly: matching
//       is prefix + '/' (so 'Area' never captures 'Area 2/x.md'), and
//       matching is exact-path-free — the folder itself is not a path in
//       the pending map (folders never reach the lane; isEmittable
//       filters them at observation), so only descendant paths matter.
//     - Window discipline: cancelling the LAST pending path also cancels
//       the debounce window (cancelPending's precedent — an armed timer
//       over an empty map is a flush that will no-op; cheaper to stand
//       down now and let the next observation re-arm).
//
// DECLARED LIMITATIONS (loud, not hidden):
//   - Crash inside the coalescing window loses the modify. Recovery is
//     boot-heal (F03's regime). note.modified is Tier-1 AT REST, deferred
//     IN OBSERVATION; the deferral window is heal-covered. Registered
//     tension, ratified as accepted.
//   - Pre-arm modifies are DROPPED, not buffered (Q3, ratified): while the
//     writer is dark, disk-vs-spine divergence is already heal's exact
//     regime. Re-buffering buys nothing heal doesn't provide and risks
//     resurrection storms on the capped buffer.
//   - actor 'sync' indistinguishable from 'user' in v1 — inherited from
//     the watcher lane's scope ruling (2026-10-25), not re-litigated here.
//   - Disclosure (overflow, gap refusal, unrouted paths) requires
//     reportIntegrity wired by the adapter; without it these limits are
//     silent-in-principle (watcher precedent, same shape).
//
// Pure module, injected deps — the gate.ts / watch.ts tradition. main.ts
// maps TAbstractFile to onVaultModify, calls cancelPending from the delete
// and rename handlers, calls cancelPrefix from the FOLDER-rename handler
// (before the folder.renamed emission, per the rev B ruling), wires arm()
// at writer attach, and supplies the scheduler (setTimeout wrappers) if
// automatic windows are wanted.
//
// Emission payload in schema canon order: path, mtime, bytes, content_sha
// (Event Log Schema v0.2, file events table).
//
// Fidelity rules this module carries:
// - Stats AT OBSERVATION TIME — never re-stat at flush (S4 stat-drift trap).
// - The lane keeps no truth of its own: spine state is read fresh at every
//   flush; the pending map holds observations, not beliefs.
// - Emission order is SORTED by path for determinism (reconcilePaths
//   precedent: the spine deserves better than enumeration order).
// - Pending is cleared BEFORE emission begins — observations arriving
//   mid-flush start a fresh window; a retry cannot double-emit what
//   already went through (flushAfterAttach precedent).
//
// Node note: erasable TypeScript only; imports spell out .ts extensions.
// =============================================================================

import type { FileLike, StatSnapshot } from '../watcher/watch.ts';
import { mergeScan, type ByteSource, type ParsedLine } from '../eventlog/reader.ts';
import { projectPaths } from '../eventlog/projection.ts';

// -----------------------------------------------------------------------------
// Structural types
// -----------------------------------------------------------------------------

/** A modify observation, frozen at observation time. */
export interface ModifyFact {
    readonly path: string;
    readonly mtime: number;
    readonly bytes: number;
    readonly content_sha: string;
}

/** Last spine-recorded state for a path — the comparison basis (F08's subject). */
interface PathState {
    readonly mtime: number;
    readonly bytes: number;
    readonly content_sha: string;
}

export interface PlannerDeps {
    /** Adapter-supplied stat at observation time. */
    stat: (path: string) => Promise<StatSnapshot>;
    /** Adapter-supplied content sha (16 hex chars, shard convention). */
    contentSha: (path: string) => Promise<string>;
    /** The Tier-1 append lane. Armed callers only — suppression is simply NOT calling this. */
    appendEvent: (
        actor: 'user',
        type: 'note.modified',
        payload: Record<string, unknown>,
    ) => Promise<void>;
    /** Optional integrity lane — overflow, gap refusal, unrouted disclosures ride it. */
    reportIntegrity?: (detail: string) => Promise<void>;
    /** Routing hook: modify observed for a path the spine never knew. Wire to the create lane. */
    routeCreate?: (path: string) => Promise<void>;
    /** Routing hook: modify observed for a path the spine says is dead. Wire to reconcile. */
    routeRestore?: (path: string) => Promise<void>;
    /** Optional scheduler — supplies automatic debounce windows. Without it, flush() is manual-only. */
    scheduler?: {
        setTimer: (cb: () => void, ms: number) => number;
        clearTimer: (handle: number) => void;
    };
}

export interface PlannerContext {
    /** Shard source for the flush-time spine read. */
    readonly source: ByteSource;
    /** The events directory (per-origin shards live here). */
    readonly eventsDir: string;
}

export interface PlannerOptions {
    /** Coalescing window, ms. Default 30_000 (the map's debouncer figure). */
    readonly windowMs?: number;
    /** Pending-observation cap (distinct paths). Default 500 (dark-buffer precedent). */
    readonly maxPending?: number;
}

export interface FlushResult {
    /** note.modified events appended. */
    readonly emitted: number;
    /** No-op modifications suppressed — zero events, zero seq (F08's counter). */
    readonly suppressed: number;
    /** Observations routed to the create lane (spine-unknown paths). */
    readonly routedCreate: number;
    /** Observations routed to reconcile (spine-dead paths). */
    readonly routedRestore: number;
    /** True if a seq gap refused the flush. Pending is dropped when refused. */
    readonly refused: boolean;
}

export interface PlannerLane {
    /** Observe a modification. Stats at observation time; last-wins per path. */
    onVaultModify(file: FileLike): Promise<void>;
    /** Cancel a path's pending modify — adapter calls this on delete and rename. */
    cancelPending(path: string): void;
    /**
     * Cancel every pending modify under a folder prefix — adapter calls
     * this from the FOLDER-rename handler, BEFORE the folder.renamed
     * emission (rev B ruling, 2026-10-30). Boundary-matched: prefix+'/',
     * so 'Area' never cancels 'Area 2/x.md' (gate.renamePrefix's
     * discipline, mirrored). Observations DIE with the address — no
     * migration, no fabricated re-observation at the destination; the
     * renamed subtree's coverage is heal's regime.
     *
     * Returns the count of pending observations cancelled, for receipts
     * and fixture assertions through the public API.
     */
    cancelPrefix(from: string): number;
    /** Arm the lane (writer attached). Pre-arm observations are dropped, heal-covered. */
    arm(): void;
    /** Flush the coalescing window: spine read, dedup, emission, routing. */
    flush(): Promise<FlushResult>;
    /** Distinct paths with a pending observation. */
    readonly pendingCount: number;
}

// -----------------------------------------------------------------------------
// Path-state fold
// -----------------------------------------------------------------------------

/**
 * Last recorded (mtime, bytes, content_sha) per path, as an ORDERED fold
 * over spine events — the same discipline as projectPaths, kept here per
 * the projection's own out-of-scope rule ("stays with the consumer until
 * a second consumer exists"). Moves to the projection family when the
 * index projection seam arrives.
 *
 * Semantics:
 *   note.created / note.modified => state set (complete records only —
 *     a partial record never overwrites good state)
 *   note.renamed                  => state moves from -> to (sha is
 *     path-independent; R6, chunks carry over)
 *   note.deleted                  => state dies with the path
 *
 * Unknown event types are ignored (forward-compat, projection precedent).
 * A live path with NO recorded state (malformed or pre-schema records)
 * compares as "changed" — the emit-safe direction, never suppress on doubt.
 */
function lastStateByPath(events: ParsedLine[]): Map<string, PathState> {
    const state = new Map<string, PathState>();

    for (const e of events) {
        const t = String(e.type);
        if (t === 'note.created' || t === 'note.modified') {
            if (
                typeof e.path === 'string' &&
                typeof e.mtime === 'number' &&
                typeof e.bytes === 'number' &&
                typeof e.content_sha === 'string'
            ) {
                state.set(e.path, {
                    mtime: e.mtime,
                    bytes: e.bytes,
                    content_sha: e.content_sha,
                });
            }
            // Incomplete record: leave prior state standing — never
            // overwrite good truth with partial truth.
        } else if (t === 'note.renamed') {
            const from = e.from;
            const to = e.to;
            if (typeof from === 'string' && typeof to === 'string') {
                const carried = state.get(from);
                state.delete(from);
                if (carried !== undefined) {
                    state.set(to, carried);
                }
            }
        } else if (t === 'note.deleted') {
            if (typeof e.path === 'string') {
                state.delete(e.path);
            }
        }
    }

    return state;
}

// -----------------------------------------------------------------------------
// The lane
// -----------------------------------------------------------------------------

export function makePlanner(
    deps: PlannerDeps,
    ctx: PlannerContext,
    options: PlannerOptions = {},
): PlannerLane {
    const windowMs = options.windowMs ?? 30_000;
    const maxPending = options.maxPending ?? 500;

    // Observations, not beliefs: last-wins per path (Map insertion order
    // is the arrival order — the overflow lane's "oldest" is well-defined).
    const pending = new Map<string, ModifyFact>();

    let armed = false; // observations before arm() are dropped, heal-covered
    let droppedOverflow = 0;
    let timerHandle: number | null = null;
    let inFlight: Promise<FlushResult> | null = null;

    /** Optional-lane integrity wrapper: silent only when no lane is wired. */
    async function integrity(detail: string): Promise<void> {
        if (deps.reportIntegrity !== undefined) {
            await deps.reportIntegrity(detail);
        }
    }

    /** Silent-path filter: nothing consumed for folders or non-md. */
    function isEmittable(file: FileLike): boolean {
        if (file.isFolder) return false;
        return file.ext.toLowerCase() === 'md';
    }

    /** Arm the (single) debounce window. Idempotent while scheduled. */
    function scheduleWindow(): void {
        if (deps.scheduler === undefined) return; // manual-flush mode
        if (timerHandle !== null) return;
        timerHandle = deps.scheduler.setTimer(() => {
            timerHandle = null;
            void flush();
        }, windowMs);
    }

    function cancelWindow(): void {
        if (deps.scheduler !== undefined && timerHandle !== null) {
            deps.scheduler.clearTimer(timerHandle);
            timerHandle = null;
        }
    }

    async function onVaultModify(file: FileLike): Promise<void> {
        if (!armed) return; // pre-arm drop — Q3 ruling, heal-covered, declared
        if (!isEmittable(file)) return;

        // Stats AT OBSERVATION TIME — the file may change before flush (S4).
        const stat = await deps.stat(file.path);
        const sha = await deps.contentSha(file.path);

        // Coalescing: last-wins per path. On first-arrival overflow, drop
        // the OLDEST pending path (insertion order) and disclose at flush —
        // the dark-buffer ruling's shape, applied to the coalescing window.
        if (!pending.has(file.path) && pending.size >= maxPending) {
            const oldest = pending.keys().next().value;
            if (oldest !== undefined) {
                pending.delete(oldest);
                droppedOverflow++;
            }
        }

        pending.set(file.path, {
            path: file.path,
            mtime: stat.mtime,
            bytes: stat.bytes,
            content_sha: sha,
        });

        scheduleWindow();
    }

    async function runFlush(): Promise<FlushResult> {
        if (pending.size === 0) {
            return { emitted: 0, suppressed: 0, routedCreate: 0, routedRestore: 0, refused: false };
        }

        // Window discipline: stop the timer, take the batch, clear BEFORE
        // emission. Observations arriving mid-flush open a fresh window; a
        // retried flush cannot double-emit what already went through.
        cancelWindow();
        const batch = [...pending.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); // deterministic
        pending.clear();

        // Disclose overflow BEFORE the survivors land — the record names
        // the loss before it names what remains (flushAfterAttach precedent).
        if (droppedOverflow > 0) {
            const n = droppedOverflow;
            droppedOverflow = 0;
            await integrity(
                `planner coalescing overflow: ${n} pending modify observations dropped ` +
                '(oldest) — window exceeded distinct-path cap',
            );
        }

        // Flush-time spine read: STATE BASIS IS THE SPINE, read fresh.
        const scan = await mergeScan(ctx.source, ctx.eventsDir);

        // Gap refusal: emitting into a gapped spine fabricates a record.
        // Pending is dropped, not retained — heal is the recovery path.
        if (scan.gaps.length > 0) {
            for (const g of scan.gaps) {
                await integrity(
                    `planner refused: seq gap (origin: ${g.origin}, ` +
                    `expected_seq: ${g.expected_seq}, got_seq: ${g.got_seq}) — ` +
                    `spine must be contiguous before modification emission; ` +
                    `${batch.length} pending observations dropped, heal is the recovery path`,
                );
            }
            return { emitted: 0, suppressed: 0, routedCreate: 0, routedRestore: 0, refused: true };
        }

        const { livePaths, deadPaths } = projectPaths(scan.events);
        const stateByPath = lastStateByPath(scan.events);

        let emitted = 0;
        let suppressed = 0;
        let routedCreate = 0;
        let routedRestore = 0;

        for (const [, fact] of batch) {
            // Routing first: the spine's live-set decides what this
            // observation even IS. Unknown paths are creates; dead paths
            // are restored-file divergence — reconcile's ruling, not ours.
            if (!livePaths.has(fact.path)) {
                if (deadPaths.has(fact.path)) {
                    if (deps.routeRestore !== undefined) {
                        await deps.routeRestore(fact.path);
                        routedRestore++;
                    } else {
                        await integrity(
                            `planner: spine-dead path with pending modify ` +
                            `(path: ${fact.path}) — routeRestore unwired, ` +
                            'observation dropped (heal-covered)',
                        );
                    }
                } else {
                    if (deps.routeCreate !== undefined) {
                        await deps.routeCreate(fact.path);
                        routedCreate++;
                    } else {
                        await integrity(
                            `planner: spine-unknown path with pending modify ` +
                            `(path: ${fact.path}) — routeCreate unwired, ` +
                            'observation dropped (heal-covered)',
                        );
                    }
                }
                continue;
            }

            const recorded = stateByPath.get(fact.path);

            // F08's decision rule, schema-literal: same sha + mtime =>
            // no event, no seq. Suppressing is simply NOT calling
            // appendEvent — the writer reserves nothing, the counter
            // advances for no one. Either field differing => emit;
            // MISSING recorded state also emits (never suppress on doubt).
            if (
                recorded !== undefined &&
                recorded.mtime === fact.mtime &&
                recorded.content_sha === fact.content_sha
            ) {
                suppressed++;
                continue;
            }

            await deps.appendEvent('user', 'note.modified', {
                path: fact.path,
                mtime: fact.mtime,
                bytes: fact.bytes,
                content_sha: fact.content_sha,
            });
            emitted++;
        }

        return { emitted, suppressed, routedCreate, routedRestore, refused: false };
    }

    function flush(): Promise<FlushResult> {
        // Concurrent flush joins the in-flight one — the lane serializes
        // itself rather than trusting the adapter to.
        if (inFlight !== null) return inFlight;
        inFlight = runFlush().finally(() => {
            inFlight = null;
        });
        return inFlight;
    }

    return {
        onVaultModify,
        cancelPending(path: string): void {
            // Tombstone and rename both land here (ratified): the pending
            // modify dies with the event that supersedes it. Quiet — the
            // cancelling event IS the record.
            pending.delete(path);
            if (pending.size === 0) cancelWindow();
        },
        cancelPrefix(from: string): number {
            // rev B (F14, 2026-10-30): a folder rename mass-invalidates
            // every storage address beneath `from/`. Pending observations
            // at those addresses die here — BEFORE the adapter emits
            // folder.renamed (ruled; the ordering lives in main.ts).
            //
            // Boundary discipline mirrors gate.renamePrefix: the match
            // is prefix + '/', so 'Area' never captures 'Area 2/x.md'.
            // The folder itself is never a pending key (folders are
            // filtered at observation), so descendant-only matching is
            // the whole surface.
            //
            // Observations DIE, they do not migrate: no fabricated
            // re-observation at the destination (the vault produced no
            // such event), coverage re-derives via boot-heal. Quiet on
            // the spine — folder.renamed IS the record — but the count
            // returns so fixtures and adapters can receipt the kill.
            const fromPrefix = from.endsWith('/') ? from : `${from}/`;
            let cancelled = 0;
            for (const key of [...pending.keys()]) {
                if (key.startsWith(fromPrefix)) {
                    pending.delete(key);
                    cancelled++;
                }
            }
            if (pending.size === 0) cancelWindow(); // empty map: stand down
            return cancelled;
        },
        arm(): void {
            armed = true;
        },
        flush,
        get pendingCount(): number {
            return pending.size;
        },
    };
}
