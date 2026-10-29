// =============================================================================
// Vault Overseer — Event Log
// src/eventlog/eventlog.ts
//
// The append-only spine writer. Per-origin single-writer: this module and
// ONLY this module appends to `events/{origin}.jsonl`. Plugin 2 reaches the
// log through this class's public API — never by touching the shard file.
//
// Tier policy (Event Log Schema v0.2):
//   Tier 1 (write-through): file facts, log.integrity, log.checkpoint. Written immediately.
//   Tier 2 (buffered):       note.opened, chunk.*, link.*, embed.batch.
//     Flushed at 64 events / 3s idle / hard cap 512, plus farewell flush
//     on dispose(). Loss of one buffer window is tolerable by design —
//     those events are re-derivable (F03's whole premise). Thresholds are
//     settings (Zone 3 tunables), not constants.
//
// Sequencing rules:
//   - seq is assigned at append time, monotonic per origin. Gaps are
//     alarms, not trivia (F02).
//   - On-disk lines stay in seq order: a Tier-1 append carries any pending
//     Tier-2 buffer ahead of it in the same write. This matters — the
//     gap detector reads line order.
//   - A failed Tier-1 write rolls its seq back. Buffer contents survive
//     a failed flush and retry on the next flush attempt.
//   - Torn-tail resume: if startup detected a torn tail, the FIRST append
//     prepends '\n' so the torn fragment becomes a dead line (skipped by
//     reader), subsequent lines stay clean. Existing bytes untouched.
//
// Checkpoints (ratified 2026-10-21):
//   - Emitted on shutdown (dispose()) if any events were appended,
//     or automatically every checkpointInterval events (default 10k).
//   - Digest computed by walking the shard from genesis — O(file)
//     per checkpoint, milliseconds at single-digit MB/year.
//   - Coverage invariant: checkpoint at seq S covers 1..S−1
//     (policed by verifyChain + F11; never-fabricate).
//
// Subscriber seam (rev. 2026-10-29):
//   - subscribe(name?, cb): register a live tap on the serialized queue
//   - unsubscribe(): returned handle, idempotent
//   - Notifications fire AFTER disk append succeeds (Tier-2 included)
//   - Subscriber errors are logged, never propagated to the writer
//
// SUBSCRIBER-THROW HAZARD RULING (rev. 2026-10-29):
//   A subscriber that throws on EVERY event, including log.integrity,
//   creates a SELF-SUSTAINING LOOP — throw → reportIntegrity → new
//   integrity event → fanout → throw → ... unbounded shard growth.
//   Fixed: notifySubscribers() skips fanout for integrity events born
//   of subscriber errors. Logs once to error channel, no unbounded
//   recursion. F13 certified the containment before the fix; F13 re-runs
//   green after the fix as the witness. The hazard is retired, not parked.
// =============================================================================

import type {
    Actor,
    EventType,
    VaultOverseerEvent,
} from './types.ts';
import { SCHEMA_VERSION, serializeEvent as serializeLine } from './types.ts';
import { computeChain } from './checkpoint.ts';

/**
 * Minimal structural adapter this module needs. Obsidian's DataAdapter
 * satisfies it, and so does the test harness's FakeAdapter — the log
 * runs in plain Node with zero Obsidian runtime (corpus rule 1).
 */
export interface LogAdapter {
    append(path: string, data: string): Promise<void>;
    write(path: string, data: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    /** Read raw file bytes. Obsidian's DataAdapter and FakeAdapter both satisfy this. */
    readBinary(path: string): Promise<Uint8Array | undefined>;
}

export interface EventLogSettings {
    /** Tier-2 flush at this many buffered events. Default 64. */
    tier2FlushCount?: number;
    /** Tier-2 flush after this much idle time, ms. Default 3000. */
    tier2IdleMs?: number;
    /** Tier-2 absolute capacity before a forced flush. Default 512. */
    tier2HardCap?: number;
    /** Emit log.checkpoint after this many events since the last. Default 10000. */
    checkpointInterval?: number;
}

export interface EventLogOptions {
    adapter: LogAdapter;
    /** This device's id. The only shard we ever write to. */
    origin: string;
    /** Directory holding the shards, vault-root-relative. */
    eventsDir?: string;
    /** Highest seq already on disk, from startup checks. 0 for fresh shard. */
    initialSeq?: number;
    /** Injectable clock for fixtures: returns ISO 8601 with offset. */
    now?: () => string;
    settings?: EventLogSettings;
    /** TRUE if startupChecks() detected a torn tail; writer will prepend '\n' on first append. */
    hasTornTail?: boolean;
}

/** Tier 2 = buffered. Everything else is write-through. */
const TIER2_TYPES: ReadonlySet<EventType> = new Set<EventType>([
    'note.opened',
    'chunk.indexed',
    'chunk.evicted',
]);

const DEFAULT_EVENTS_DIR = '_vault-index/events';

// Subscriber seam — internal types
type SubscriberCallback = (event: VaultOverseerEvent) => void;
interface Subscriber {
    readonly name?: string;
    readonly cb: SubscriberCallback;
}

export class EventLog {
    private readonly adapter: LogAdapter;
    private readonly origin: string;
    private readonly shardPath: string;
    private readonly eventsDir: string;
    private readonly now: () => string;
    private readonly flushCount: number;
    private readonly idleMs: number;
    private readonly hardCap: number;
    private readonly checkpointInterval: number;
    private sinceCheckpoint = 0;

    private seq: number;
    private buffer: Array<{ line: string; event: VaultOverseerEvent }> = [];
    private ready = false;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private hasTornTail: boolean;

    /** Serialized append queue: one write at a time, ever. */
    private queueTail: Promise<void> = Promise.resolve();

    /** Subscriber seam — live taps on the serialized queue. */
    private subscribers: Subscriber[] = [];

    constructor(opts: EventLogOptions) {
        this.adapter = opts.adapter;
        this.origin = opts.origin;
        this.eventsDir = opts.eventsDir ?? DEFAULT_EVENTS_DIR;
        this.shardPath = `${this.eventsDir}/${this.origin}.jsonl`;
        this.seq = opts.initialSeq ?? 0;
        this.now = opts.now ?? defaultLocalIso;
        const s = opts.settings ?? {};
        this.flushCount = s.tier2FlushCount ?? 64;
        this.idleMs = s.tier2IdleMs ?? 3000;
        this.hardCap = s.tier2HardCap ?? 512;
        this.checkpointInterval = s.checkpointInterval ?? 10_000;
        this.hasTornTail = opts.hasTornTail ?? false;
    }

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /**
     * Append one event. The caller supplies actor, type, and payload —
     * nothing else. v, seq, ts, and origin are owned here: the writer
     * assigns them, so no caller can forge a sequence number or stamp a
     * foreign origin onto this shard.
     */
    async appendEvent<T extends EventType>(
        actor: Actor,
        type: T,
        payload: Extract<VaultOverseerEvent, { type: T }>['payload'],
    ): Promise<void> {
        return this.run(() => this.appendLocked(actor, type, payload));
    }

    /**
     * Shorthand for integrity reporting — tier 1, write-through, always.
     * Silence is disqualifying, so this is a public door, not an internal.
     */
    reportIntegrity(detail: string): Promise<void> {
        return this.appendEvent('plugin', 'log.integrity', { detail });
    }

    /** Farewell flush: drains the Tier-2 buffer and stops the idle timer. */
    async dispose(): Promise<void> {
        if (this.idleTimer !== null) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        await this.run(async () => {
            await this.flushLocked();
            if (this.sinceCheckpoint > 0) await this.checkpointLocked();
        });
    }

    /** Manually emit a log.checkpoint now (Tier 1, write-through). */
    async checkpoint(): Promise<void> {
        return this.run(() => this.checkpointLocked());
    }

    /** Current seq (highest assigned). Diagnostic/tests. */
    get lastSeq(): number {
        return this.seq;
    }

    /** Buffered-but-unwritten Tier-2 lines. Diagnostic/tests. */
    get pendingCount(): number {
        return this.buffer.length;
    }

    /**
     * Subscriber seam: register a live tap on the serialized queue.
     * Callback fires after every successful appendEvent() commit.
     * @param name Optional identifier for error reporting
     * @returns Unsubscribe handle (idempotent)
     */
    subscribe(name: string | undefined, cb: SubscriberCallback): () => void {
        const subscriber: Subscriber = { name, cb };
        this.subscribers.push(subscriber);
        return () => {
            const idx = this.subscribers.indexOf(subscriber);
            if (idx !== -1) {
                this.subscribers.splice(idx, 1);
            }
        };
    }

    // ---------------------------------------------------------------------------
    // Internals — everything below runs inside the serialized queue
    // ---------------------------------------------------------------------------

    private async appendLocked(
        actor: Actor,
        type: EventType,
        payload: unknown,
    ): Promise<void> {
        await this.ensureShardLocked();
        // Threshold auto-checkpoint fires BEFORE the new event, so the
        // checkpoint never needs to account for a half-appended line.
        if (this.sinceCheckpoint >= this.checkpointInterval && type !== 'log.checkpoint') {
            await this.checkpointLocked();
        }
        const seq = ++this.seq;
        this.sinceCheckpoint++;
        // Generic union assembly requires one cast; it is contained here and
        // nowhere else. The serializer still owns key order.
        const event = {
            v: SCHEMA_VERSION,
            seq,
            ts: this.now(),
            origin: this.origin,
            actor,
            type,
            payload,
        } as unknown as VaultOverseerEvent;

        const line = serializeLine(event);

        if (TIER2_TYPES.has(type)) {
            this.buffer.push({ line, event });
            this.scheduleIdleFlush();
            if (this.buffer.length >= this.hardCap || this.buffer.length >= this.flushCount) {
                await this.flushLocked();
            }
            return;
        }

        // Tier 1: carry the buffer ahead of this line so disk order == seq
        // order, in a single append. On failure: buffer survives for retry,
        // this event's seq rolls back.
        const combined = this.buffer.length > 0
        ? this.buffer.map(b => b.line).join('') + line
        : line;
        try {
            // Torn-tail resume: prepend '\n' on first append so the torn fragment
            // becomes a dead line (skipped by reader), subsequent lines stay clean.
            const writeData = this.hasTornTail ? '\n' + combined : combined;
            this.hasTornTail = false; // consume the flag — never prepend again
            await this.adapter.append(this.shardPath, writeData);
            this.buffer = [];
            this.stopIdleFlush();
            // Notify subscribers AFTER disk append succeeds
            this.notifySubscribers(event);
        } catch (err) {
            this.seq = seq - 1; // roll back — this seq was never written
            throw err;
        }
    }

    private async flushLocked(): Promise<void> {
        if (this.buffer.length === 0) return;
        const combined = this.buffer.map(b => b.line).join('');
        await this.adapter.append(this.shardPath, combined);
        // Notify subscribers AFTER disk append succeeds
        for (const { event } of this.buffer) {
            this.notifySubscribers(event);
        }
        this.buffer = [];
        this.stopIdleFlush();
    }

    /**
     * Write one log.checkpoint line. The digest is computed by WALKING the
     * shard from genesis — O(file) per checkpoint, milliseconds at
     * single-digit MB/year. Walking rather than incrementally maintaining
     * chain state means the digest can never desync from disk: no rollback
     * hazards, no torn-tail special cases, no buffer-carry ordering traps.
     * Coverage invariant: last_seq == highest seq on disk == this line's
     * seq − 1 (asserted downstream by verifyChain, policed by F11).
     */
    private async checkpointLocked(): Promise<void> {
        // Drain the buffer first — the digest covers what is on disk.
        await this.flushLocked();
        const bytes = await this.adapter.readBinary(this.shardPath);
        const { chain, lastSeq } = computeChain(bytes ?? new Uint8Array(0), this.origin);
        const seq = ++this.seq;
        this.sinceCheckpoint = 0;
        const event = {
            v: SCHEMA_VERSION,
            seq,
            ts: this.now(),
            origin: this.origin,
            actor: 'plugin',
            type: 'log.checkpoint',
            payload: { last_seq: lastSeq, events: lastSeq, digest: chain },
        } as unknown as VaultOverseerEvent;
        const line = serializeLine(event);
        const writeData = this.hasTornTail ? '\n' + line : line;
        this.hasTornTail = false;
        try {
            await this.adapter.append(this.shardPath, writeData);
            // Notify subscribers AFTER disk append succeeds
            this.notifySubscribers(event);
        } catch (err) {
            this.seq = seq - 1; // roll back — this seq was never written
            throw err;
        }
    }

    /**
     * Fire all registered subscribers. Errors are logged, never propagated.
     * Called only after successful disk append.
     *
     * HAZARD RULING (2026-10-29): a subscriber throwing on log.integrity
     * would create an unbounded self-loop (throw → reportIntegrity →
     * integrity event → fanout → throw → ...). The fix: skip fanout for
     * integrity events born of subscriber errors. Logs once to error
     * channel, no recursion. F13 certifies containment before and after.
     */
    private notifySubscribers(event: VaultOverseerEvent): void {
        for (const { name, cb } of this.subscribers) {
            try {
                cb(event);
            } catch (err) {
                const who = name ?? '<anonymous>';
                // Skip fanout for integrity errors — prevents unbounded recursion
                // if a subscriber throws on log.integrity events.
                if (event.type !== 'log.integrity') {
                    void this.reportIntegrity(
                        `subscriber threw: ${who} — ${String(err)}`,
                    );
                } else {
                    // Still log to console.error for debugging, but don't re-enqueue
                    console.error(`[eventlog] subscriber threw on integrity event: ${who} — ${String(err)}`);
                }
            }
        }
    }

    private async ensureShardLocked(): Promise<void> {
        if (this.ready) return;
        if (!(await this.adapter.exists(this.eventsDir))) {
            await this.adapter.mkdir(this.eventsDir);
        }
        if (!(await this.adapter.exists(this.shardPath))) {
            await this.adapter.write(this.shardPath, '');
        }
        this.ready = true;
    }

    private scheduleIdleFlush(): void {
        if (this.idleTimer !== null) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            void this.run(() => this.flushLocked());
        }, this.idleMs);
    }

    private stopIdleFlush(): void {
        if (this.idleTimer !== null) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    private run(task: () => Promise<void>): Promise<void> {
        const run = this.queueTail.then(() => task());
        // Keep the chain alive even if a task throws; the original rejection
        // propagates to the caller of appendEvent.
        this.queueTail = run.then(
            () => undefined,
                                  () => undefined,
        );
        return run;
    }
}

// -----------------------------------------------------------------------------
// Clock — ISO 8601 with local offset (origin-local wall clock, diagnostic
// only; merge-scan never trusts ts for ordering)
// -----------------------------------------------------------------------------

export function defaultLocalIso(d: Date = new Date()): string {
    const offsetMin = -d.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    const local = new Date(d.getTime() + offsetMin * 60_000);
    const y = local.getFullYear();
    const mo = String(local.getMonth() + 1).padStart(2, '0');
    const da = String(local.getDate()).padStart(2, '0');
    const h = String(local.getHours()).padStart(2, '0');
    const mi = String(local.getMinutes()).padStart(2, '0');
    const se = String(local.getSeconds()).padStart(2, '0');
    return `${y}-${mo}-${da}T${h}:${mi}:${se}${sign}${hh}:${mm}`;
}
