// =============================================================================
// Vault Overseer — Dwell Gate (extracted, pure)
// src/dwell/gate.ts
//
// The dwell gate's v1 semantics, lifted out of the Plugin class into a
// pure module — per main.ts's own header doctrine ("everything here is
// wiring; the spine's semantics live in modules"). Observable clock and
// timer are injected (same seam shape as EventLog's `now?: () => string`),
// and emission rides a callback, so the gate runs in plain Node under
// F09 with zero Obsidian runtime and zero internal mocking.
//
// v1 SEMANTICS (ratified 2026-10-23, carried verbatim from 0.1.2's
// in-plugin implementation):
//   - Threshold-only emission: the gate fires when a note's accrued
//     dwell crosses gateMs (default 10s). Threshold emissions carry
//     dwell = gate/1000 FLAT — richer values belong to a close-emit
//     world this version does not build.
//   - Accumulation across openings: dwell banks per note when the note
//     is switched away from or the workspace empties; a return visit's
//     timer arms for gate MINUS what's already banked.
//   - One event per crossing; emission RESETS that note's accrual and
//     rebaselines openAt. Continued dwelling after an emission banks
//     toward the farewell flush ONLY — no second timer ever re-arms
//     for a note that has already crossed this session. Farewell
//     dwell is measured FROM the emission, so an emission plus further
//     dwell reports only the post-emission portion (a crossed note's
//     pre-emission dwell has already been spoken for).
//   - Farewell (sessionEnd): over-gate accruals are RETURNED to the
//     caller with actual dwell-so-far (floor seconds, may exceed the
//     gate) and the note's LAST-KNOWN PATH; under-gate accruals are
//     discarded — a swipe-through does not become signal just because
//     the session ended.
//   - The gate knows nothing about the writer. Dark-writer drops are
//     the adapter's (main.ts emitDwell) declared v1 limitation.
//
// COLLISION FIX (v1.1, ratified 2026-10-24): the accrual map keys by
// OPAQUE noteId (TFile identity, derived in main.ts via WeakMap), not
// by path. Obsidian reuses `Notes/Untitled.md` across successive
// creations; path keying let a later creation inherit a dead
// predecessor's banked dwell and fire early (live-observed 2026-10-23).
// Distinct ids never share a lane, whatever their paths.
//
// DECLARED, NOT FIXED HERE: placeholder-path emissions. file-open fires
// on note CREATE before the title is typed, so a threshold emission can
// permanently record `Notes/Untitled.md` — renames are not wired. F05
// owns that fix; F09 asserts the collision fix only.
//
// Corrections log (self-caught, logged not hidden):
//   Draft 1 (2026-10-24): sessionEnd() nulled the active note before
//     consulting it — farewell lane unreachable. Default schedule
//     fallback never called setTimeout.
//   Draft 2 (2026-10-24): sessionEnd() built farewells from the accrual
//     map, which carried no paths — every farewell would have emitted
//     path:''. Fixed: accrual lanes now carry (path, ms) together, and
//     open() refreshes the lane's path on every visit so a renamed-in-
//     place note reports its newest known path at session end.
//
// Node note: erasable TS, .ts import extensions, no Obsidian imports.
// =============================================================================

export interface DwellTimerHandle {
    cancel(): void;
}

export interface DwellGateOptions {
    /** Emission threshold in ms. Default 10_000. */
    gateMs?: number;
    /** Wall clock in ms. Default Date.now. */
    now?: () => number;
    /**
     * Timer scheduler. Default wraps setTimeout and returns a cancellable
     * handle. Fixtures inject a manual clock queue for determinism.
     */
    schedule?: (cb: () => void, ms: number) => DwellTimerHandle;
    /** Emission callback. May be async; the gate fire-and-forgets it. */
    emit: (path: string, dwellSeconds: number) => void | Promise<void>;
}

/** The currently open note. */
interface ActiveNote {
    noteId: string;
    path: string;
    openAt: number;
    /** True once this note has crossed the gate this session. Post-emission dwell banks toward the farewell flush only — no timer re-arms. */
    emitted: boolean;
}

/** One accrual lane: the note's last-known path plus banked dwell, ms. */
interface AccrualLane {
    path: string;
    ms: number;
}

/**
 * The dwell gate. One instance per plugin session; instantiate with the
 * emit callback and (in fixtures) a controlled clock and timer queue.
 */
export class DwellGate {
    private readonly gateMs: number;
    private readonly gateSeconds: number;
    private readonly now: () => number;
    private readonly schedule: (cb: () => void, ms: number) => DwellTimerHandle;
    private readonly emit: (path: string, dwellSeconds: number) => void | Promise<void>;

    private activeNote: ActiveNote | null = null;

    /**
     * Banked dwell per noteId, with last-known path. Session-scoped,
     * never persisted. Path refreshes on every open of that note, so
     * farewell emissions name where the note was LAST seen — F05's
     * rename wiring will supersede this convention properly.
     */
    private readonly lanes = new Map<string, AccrualLane>();

    /**
     * noteIds that have crossed the gate this session. Survives the
     * activeNote lifecycle (the note may be switched away and back);
     * presence here suppresses timer re-arming for that note for the
     * rest of the session.
     */
    private readonly crossedThisSession = new Set<string>();

    private timer: DwellTimerHandle | null = null;

    constructor(opts: DwellGateOptions) {
        this.gateMs = opts.gateMs ?? 10_000;
        this.gateSeconds = Math.floor(this.gateMs / 1000);
        this.now = opts.now ?? Date.now;
        this.schedule = opts.schedule ?? ((cb, ms) => {
            const t = setTimeout(() => cb(), ms);
            return { cancel: () => clearTimeout(t) };
        });
        this.emit = opts.emit;
    }

    // ---------------------------------------------------------------------------
    // Public surface — mirrors the plugin's actual events
    // ---------------------------------------------------------------------------

    /**
     * A file was opened. Banks the outgoing note's dwell (if any) into
     * its lane, cancels any pending timer, and arms a fresh timer for
     * the incoming note — unless that note has already crossed this
     * session, in which case its dwell simply banks.
     */
    open(noteId: string, path: string): void {
        const now = this.now();

        this.bankActive(now);
        this.clearTimer();

        const emitted = this.crossedThisSession.has(noteId);
        this.activeNote = { noteId, path, openAt: now, emitted };

        // Refresh the lane's path every visit — farewell names the
        // last-known location, and a note opened at its new path should
        // not be remembered by an older one.
        const lane = this.lanes.get(noteId);
        if (lane !== undefined) lane.path = path;

        if (emitted) return; // already crossed: dwell banks toward farewell only

        const banked = this.lanes.get(noteId)?.ms ?? 0;
        const remaining = this.gateMs - banked;
        if (remaining <= 0) {
            // Accrual already at/over the gate (e.g. banked exactly at the
            // boundary): crossing is due NOW, not on a timer.
            void this.fire();
            return;
        }
        this.armTimer(remaining);
    }

    /** file-open fired with null: the workspace holds no file. Bank, stand down. */
    noFileOpen(): void {
        this.bankActive(this.now());
        this.clearTimer();
    }

    /**
     * Session end. Banks the active note, cancels any pending timer, and
     * RETURNS the over-gate accruals (actual dwell-so-far since the last
     * emission, floor seconds, with each lane's last-known path) for the
     * caller to emit before dispose(). Under-gate accruals are discarded
     * — silence is the v1 ruling. Clears all lanes.
     */
    sessionEnd(): Array<{ path: string; dwellSeconds: number }> {
        this.bankActive(this.now());
        this.clearTimer();

        const farewells: Array<{ path: string; dwellSeconds: number }> = [];
        for (const lane of this.lanes.values()) {
            if (lane.ms >= this.gateMs) {
                farewells.push({
                    path: lane.path,
                    dwellSeconds: Math.floor(lane.ms / 1000),
                });
            }
        }
        this.lanes.clear();
        this.crossedThisSession.clear();
        return farewells;
    }

    // ---------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------

    /** Add the active note's elapsed dwell to its lane, then drop it. */
    private bankActive(now: number): void {
        if (this.activeNote === null) return;
        const elapsed = now - this.activeNote.openAt;
        if (elapsed > 0) {
            const existing = this.lanes.get(this.activeNote.noteId);
            if (existing !== undefined) {
                existing.path = this.activeNote.path;
                existing.ms += elapsed;
            } else {
                this.lanes.set(this.activeNote.noteId, {
                    path: this.activeNote.path,
                    ms: elapsed,
                });
            }
        }
        this.activeNote = null;
    }

    private clearTimer(): void {
        if (this.timer !== null) {
            this.timer.cancel();
            this.timer = null;
        }
    }

    private armTimer(remainingMs: number): void {
        const note = this.activeNote;
        if (note === null) return;
        this.timer = this.schedule(() => {
            this.timer = null;
            void this.fire();
        }, remainingMs);
    }

    /**
     * The gate crossing. Emits flat gate seconds, resets the accrual,
     * rebaselines openAt, and marks the note crossed — its continued
     * dwell now banks toward the farewell flush only.
     *
     * Defensive: a late timer firing after the note switched away is
     * ignored (open/noFileOpen cancel the timer, but belt and braces —
     * a fire with no active note, or for a note already emitted, is a
     * no-op, never an orphan emission).
     */
    private async fire(): Promise<void> {
        const note = this.activeNote;
        if (note === null || note.emitted) return;

        this.clearTimer();
        note.emitted = true;
        this.crossedThisSession.add(note.noteId);

        // Reset the lane: the crossing is what this lane has to say.
        // Post-emission dwell accumulates from openAt's rebaseline.
        this.lanes.set(note.noteId, { path: note.path, ms: 0 });
        note.openAt = this.now();

        await this.emit(note.path, this.gateSeconds);
    }
}
