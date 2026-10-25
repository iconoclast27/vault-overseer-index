// =============================================================================
// Vault Overseer — Watcher Lane (F12 module under test)
// src/watcher/watch.ts
//
// rev B (2026-10-25, pre-wiring alignment to Schema v0.2 catalog):
//   - note.deleted now carries last_content_sha (the tombstone payload):
//     the lane tracks the last-known sha per path from every create's
//     observation, and a delete CONSUMES it. A delete of a path the lane
//     never observed (pre-watcher file, rename-then-delete) emits
//     path-only — DECLARED limitation; the spine still gets the path
//     tombstone, and rename reconciliation is the projection's job.
//   - Dark-buffer cap (session ruling 2026-10-25): 500 facts default,
//     OLDEST dropped on overflow, aggregate disclosure at flush through
//     the optional reportIntegrity dep. Dropping without an integrity
//     lane wired is itself a declared limit — but the disclosure hook
//     exists precisely so main.ts can wire it.
//
// Pure module, injected deps — the gate.ts tradition. main.ts maps
// TAbstractFile → FileLike and calls these entry points.
//
// Scope ruling (2026-10-25): v1 emits note.created/note.deleted only,
// Tier-1 write-through, actor 'user'. note.modified deferred (storm
// coalescing, sync-vs-user disambiguation, debounce ruling).
// Sync-arriving files are indistinguishable from local creation in v1 —
// DECLARED limitation, registered roadmap debt (actor 'sync' eventually).
//
// Lifecycle: the lane starts DARK — every fact is buffered with its
// stats captured AT OBSERVATION TIME (never re-stat at flush). The
// adapter calls flushAfterAttach() exactly once, when the writer comes
// up (post-certification / foreign-origin guard cleared). That call
// discloses any overflow, drains the buffer in emission order, AND arms
// the lane live; every fact thereafter appends directly, Tier-1
// write-through.
//
// Fidelity rules this module carries:
// - Facts never fuse by path: create→delete→create on the same address
//   is three facts (the F09 Untitled lesson, inverted).
// - Silent paths consume nothing: folders and non-md files return
//   before any stat call or buffer growth.
// - Extension matching lowercases here — the adapter may pass any case.
// - Buffered facts keep observation-time mtime/bytes/sha even if the
//   file changes underneath before the flush (stat-drift trap, S4).
// - Overflow drops OLDEST first, discloses the count at flush — never
//   a silent loss while a reporting lane exists.
// =============================================================================

// -----------------------------------------------------------------------------
// Structural types
// -----------------------------------------------------------------------------

/** Minimal slice of TAbstractFile the lane is allowed to know. */
export interface FileLike {
    readonly path: string;
    readonly isFolder: boolean;
    /** Extension WITHOUT the dot, any case — normalized here. */
    readonly ext: string;
}

/** Stat snapshot taken by the adapter when a vault event fires. */
export interface StatSnapshot {
    readonly mtime: number;
    readonly bytes: number;
}

export interface WatcherDeps {
    /** Adapter-supplied stat at observation time. */
    stat: (path: string) => Promise<StatSnapshot>;
    /** Adapter-supplied content sha (16 hex chars, shard convention). */
    contentSha: (path: string) => Promise<string>;
    /** The Tier-1 append lane. Called only when armed (post-attach). */
    appendEvent: (
        actor: 'user',
        type: 'note.created' | 'note.deleted',
        payload: Record<string, unknown>,
    ) => Promise<void>;
    /** Optional integrity lane — overflow disclosure rides it. */
    reportIntegrity?: (detail: string) => Promise<void>;
}

export interface WatcherOptions {
    /**
     * Dark-buffer cap. Facts observed while the writer is dark beyond
     * this count are dropped, OLDEST first, disclosed at flush.
     * Default 500 (session ruling 2026-10-25).
     */
    readonly darkBufferCap?: number;
}

/** A fact observed while dark: payload frozen at observation time. */
interface BufferedFact {
    readonly type: 'note.created' | 'note.deleted';
    readonly path: string;
    readonly mtime?: number;
    readonly bytes?: number;
    readonly content_sha?: string;
    /** Tombstone sha for deletes; absent when never observed. */
    readonly last_content_sha?: string;
}

export interface WatcherLane {
    onVaultCreate(file: FileLike): Promise<void>;
    onVaultDelete(file: FileLike): Promise<void>;
    /** Disclose overflow, drain the dark buffer, arm the lane. Call ONCE, on writer attach. */
    flushAfterAttach(): Promise<void>;
    /** Buffered-but-unflushed dark facts. */
    readonly pendingCount: number;
}

// -----------------------------------------------------------------------------
// The lane
// -----------------------------------------------------------------------------

export function makeWatcherLane(
    deps: WatcherDeps,
    options: WatcherOptions = {},
): WatcherLane {
    const cap = options.darkBufferCap ?? 500;

    const buffer: BufferedFact[] = [];
    let live = false; // dark until flushAfterAttach()
    let droppedDark = 0;

    /**
     * Last-known sha per path, fed by every create. A delete CONSUMES
     * its entry — the tombstone names what died, and a later create of
     * the same path starts a fresh sha history (no fusion, F09 lesson).
     */
    const lastShaByPath = new Map<string, string>();

    /** Silent-path filter: nothing consumed for folders or non-md. */
    function isEmittable(file: FileLike): boolean {
        if (file.isFolder) return false;
        return file.ext.toLowerCase() === 'md';
    }

    /** Emit now (armed) or freeze into the buffer (dark, capped). */
    async function emit(fact: BufferedFact): Promise<void> {
        if (!live) {
            if (buffer.length >= cap) {
                buffer.shift(); // oldest out — cap ruling 2026-10-25
                droppedDark++;
            }
            buffer.push(fact);
            return;
        }
        await append(fact);
    }

    /** Serialize a fact through the Tier-1 lane with payload in canon order. */
    async function append(fact: BufferedFact): Promise<void> {
        if (fact.type === 'note.deleted') {
            const payload: Record<string, unknown> = { path: fact.path };
            if (fact.last_content_sha !== undefined) {
                payload.last_content_sha = fact.last_content_sha;
            }
            await deps.appendEvent('user', fact.type, payload);
            return;
        }
        await deps.appendEvent('user', fact.type, {
            path: fact.path,
            mtime: fact.mtime,
            bytes: fact.bytes,
            content_sha: fact.content_sha,
        });
    }

    async function onVaultCreate(file: FileLike): Promise<void> {
        if (!isEmittable(file)) return;

        // Stats AT OBSERVATION TIME — the file may change before flush.
        const stat = await deps.stat(file.path);
        const sha = await deps.contentSha(file.path);

        lastShaByPath.set(file.path, sha);

        await emit({
            type: 'note.created',
            path: file.path,
            mtime: stat.mtime,
            bytes: stat.bytes,
            content_sha: sha,
        });
    }

    async function onVaultDelete(file: FileLike): Promise<void> {
        if (!isEmittable(file)) return;

        // Tombstone: consume the last-known sha. Absent when the lane
        // never observed this path (pre-watcher file, rename victim).
        const lastSha = lastShaByPath.get(file.path);
        lastShaByPath.delete(file.path);

        await emit({ type: 'note.deleted', path: file.path, last_content_sha: lastSha });
    }

    async function flushAfterAttach(): Promise<void> {
        // Disclose overflow BEFORE the survivors land, so the record
        // names the loss before it names what remains.
        if (droppedDark > 0) {
            const n = droppedDark;
            droppedDark = 0;
            if (deps.reportIntegrity !== undefined) {
                await deps.reportIntegrity(
                    `watcher dark-buffer overflow: ${n} file facts dropped ` +
                    '(oldest) — writer attach delayed beyond cap',
                );
            }
        }

        // Drain in emission order, then arm. Even if a flush append
        // throws, previously-appended facts are already on disk — the
        // buffer only shrinks as facts land, so a retry can't double-
        // emit what already went through.
        while (buffer.length > 0) {
            const fact = buffer.shift();
            if (fact === undefined) break;
            await append(fact);
        }
        live = true;
    }

    return {
        onVaultCreate,
        onVaultDelete,
        flushAfterAttach,
        get pendingCount() {
            return buffer.length;
        },
    };
}
