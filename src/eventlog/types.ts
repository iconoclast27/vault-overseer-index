// =============================================================================
// Vault Overseer — Event Log Types
// src/eventlog/types.ts
//
// Schema: Event Log Schema v0.2, rev. 2026-10-20 (schema v: 1)
// Scope:   Phase 1 subset — file events, chunk events, integrity events.
//          The remaining catalog types (link.*, embed.batch, skill.*,
//          write.*, session.*, settings.*, log.checkpoint) are transcribed
//          only when they gain fixture-loaded consumers. Inventory that has
//          never been bitten by a fixture is "survived the meetings" — banned.
//
// Doctrine:
//   - Envelope key order is NORMATIVE: v, seq, ts, origin, actor, type,
//     then payload fields in the order declared in each interface below.
//   - The serializer OWNS assembly. Callers never hand-construct event
//     lines. One implementation, not two drifting copies.
//   - ts is caller-supplied: ISO 8601 with offset, origin-local wall clock.
//     Diagnostic only — never trusted for ordering. The serializer stays
//     pure; clock injection belongs to EventLog/spawnContext.
//   - Line format: compact JSON, one event per line, '\n'-terminated.
//     The trailing newline is the completeness marker — F01's torn-tail
//     detection is precisely "final line lacks its terminator."
//
// FIX NOTE (2026-10-29): payloadInOrder formerly hoisted `const p =
//   event.payload` ABOVE the switch, severing the discriminant narrowing
//   — 28 TS2339 errors, declared debt since the first-ever typecheck
//   (2026-10-28). Each case now accesses `event.payload` directly so
//   narrowing flows from `event.type`. Behavior is UNCHANGED: the same
//   fields in the same order produce the same bytes. Runtime was never
//   wrong; the checker was never satisfied.
//
// F14 ADDITION (2026-10-30): 'folder.renamed' transcribed. Tier 1 file
//   fact (mass-invalidation of storage addresses), payload {from, to}
//   mirroring note.renamed — per the Schema v0.2 ledger entry rev.
//   2026-10-24. Consumer condition met: the subscriber seam (F13) is
//   the fixture-loaded consumer; the transcription doctrine is satisfied
//   for the first new event type since the doctrine was written. Fixture
//   F14 drafted from contract text (corpus addendum rev. 2026-10-30);
//   implementation sequence: types.ts (this file) → planner rev B
//   cancelPrefix → main.ts unmuting of the TFolder branch. Session
//   ruling 2026-10-30: cancelPrefix fires BEFORE the folder.renamed
//   emission — pending state dies before the fact lands.
// =============================================================================

/** Envelope schema version. Forward-only migrations keyed on this. */
export const SCHEMA_VERSION = 1 as const;

/** Attribution by record, not archaeology. */
export type Actor = 'user' | 'plugin' | 'sync';

/**
 * Per-device origin id ('mokka' | 'latitude' in production).
 * Kept as a loose string: the foreign-origin guard at startup is the
 * schema's enforcement mechanism, not the type system's job.
 */
export type Origin = string;

/** Paths: vault-relative, POSIX separators, no leading slash. */
export type VaultPath = string;

/** SHA-256 of full note file bytes, truncated to 16 hex chars. */
export type ContentSha = string;

/** SHA-256 of the exact prefixed string sent to the embedder. */
export type VectorHash = string;

// -----------------------------------------------------------------------------
// Event types — Phase 1 subset
// -----------------------------------------------------------------------------

export type EventType =
// Tier 1 — file facts (write-through)
| 'note.created'
| 'note.modified'
| 'note.deleted'
| 'note.renamed'
| 'note.conflicted'
| 'folder.renamed'
// Tier 2 — buffered
| 'note.opened'
| 'chunk.indexed'
| 'chunk.evicted'
// Tier 1 — ops: integrity + checkpoints (write-through; silence is disqualifying)
| 'log.integrity'
// Tier 1 — ops: checkpoint digest (write-through; witnessed by F11)
| 'log.checkpoint';

// -----------------------------------------------------------------------------
// Payloads — field order below is the serialization order. Do not reorder.
// -----------------------------------------------------------------------------

export interface NoteCreatedPayload {
    readonly path: VaultPath;
    readonly mtime: number;
    readonly bytes: number;
    readonly content_sha: ContentSha;
}

export interface NoteModifiedPayload {
    readonly path: VaultPath;
    readonly mtime: number;
    readonly bytes: number;
    readonly content_sha: ContentSha;
}

export interface NoteDeletedPayload {
    readonly path: VaultPath;
    readonly last_content_sha: ContentSha;
}

export interface NoteRenamedPayload {
    readonly from: VaultPath;
    readonly to: VaultPath;
}

export interface NoteConflictedPayload {
    readonly path: VaultPath;
    readonly conflict_copy_path: VaultPath;
}

/**
 * F14 (2026-10-30): a folder was renamed from `from` to `to`. One event,
 * not N children — the folder rename is a single mass-invalidation fact
 * covering every storage address beneath `from/`. The projection's
 * prefix-fold resolves descendants; links (Obsidian's province) and
 * chunk identity (path-independent vh) are untouched by construction.
 * Mirrors NoteRenamedPayload's field order exactly.
 */
export interface FolderRenamedPayload {
    readonly from: VaultPath;
    readonly to: VaultPath;
}

export interface NoteOpenedPayload {
    readonly path: VaultPath;
    /** Dwell in whole seconds, rounded down. Gate: >= 10s before emission. */
    readonly dwell: number;
}

export interface ChunkIndexedPayload {
    readonly path: VaultPath;
    readonly ord: number;
    /** Byte offset, inclusive: start of first paragraph's first byte. */
    readonly bs: number;
    /** Byte offset, exclusive: end of last paragraph's last byte. [bs, be). */
    readonly be: number;
    readonly vh: VectorHash;
    /** Chunk policy version. Owned by the chunker; the log never interprets. */
    readonly cp: number;
}

export interface ChunkEvictedPayload {
    readonly vh: VectorHash;
    readonly path: VaultPath;
}

export interface LogIntegrityPayload {
    /**
     * Loud, named, actionable. E.g. torn-tail: origin, offending byte length,
     * recovered-through seq. Gap: (origin, expected_seq, got_seq).
     */
    readonly detail: string;
}

export interface LogCheckpointPayload {
    /** Highest seq covered by the digest — always this event's seq − 1. */
    readonly last_seq: number;
    /** Total events covered (== last_seq at v1; explicit per schema catalog). */
    readonly events: number;
    /** Rolling digest over lines 1..last_seq, inclusive. */
    readonly digest: string;
}

// -----------------------------------------------------------------------------
// Event union — discriminated on `type`
// -----------------------------------------------------------------------------

interface Envelope {
    readonly v: typeof SCHEMA_VERSION;
    readonly seq: number;
    readonly ts: string;
    readonly origin: Origin;
    readonly actor: Actor;
    readonly type: EventType;
}

export interface NoteCreatedEvent extends Envelope { readonly type: 'note.created'; readonly payload: NoteCreatedPayload; }
export interface NoteModifiedEvent extends Envelope { readonly type: 'note.modified'; readonly payload: NoteModifiedPayload; }
export interface NoteDeletedEvent extends Envelope { readonly type: 'note.deleted'; readonly payload: NoteDeletedPayload; }
export interface NoteRenamedEvent extends Envelope { readonly type: 'note.renamed'; readonly payload: NoteRenamedPayload; }
export interface NoteConflictedEvent extends Envelope { readonly type: 'note.conflicted'; readonly payload: NoteConflictedPayload; }
export interface FolderRenamedEvent extends Envelope { readonly type: 'folder.renamed'; readonly payload: FolderRenamedPayload; }
export interface NoteOpenedEvent extends Envelope { readonly type: 'note.opened'; readonly payload: NoteOpenedPayload; }
export interface ChunkIndexedEvent extends Envelope { readonly type: 'chunk.indexed'; readonly payload: ChunkIndexedPayload; }
export interface ChunkEvictedEvent extends Envelope { readonly type: 'chunk.evicted'; readonly payload: ChunkEvictedPayload; }
export interface LogIntegrityEvent extends Envelope { readonly type: 'log.integrity'; readonly payload: LogIntegrityPayload; }
export interface LogCheckpointEvent extends Envelope { readonly type: 'log.checkpoint'; readonly payload: LogCheckpointPayload; }

export type VaultOverseerEvent =
| NoteCreatedEvent
| NoteModifiedEvent
| NoteDeletedEvent
| NoteRenamedEvent
| NoteConflictedEvent
| FolderRenamedEvent
| NoteOpenedEvent
| ChunkIndexedEvent
| ChunkEvictedEvent
| LogIntegrityEvent
| LogCheckpointEvent;

// -----------------------------------------------------------------------------
// Serializer — the single owner of line assembly
// -----------------------------------------------------------------------------

/**
 * Build the payload object with fields in normative order.
 * Exhaustive over the Phase 1 union: adding an EventType without adding
 * a case is a compile error via the `never` assignment check.
 *
 * FIX 2026-10-29: each case reads `event.payload` directly — the hoisted
 * `const p` severed the type narrowing. No behavior change; narrowing now
 * flows from the discriminant as designed.
 */
function payloadInOrder(event: VaultOverseerEvent): Record<string, unknown> {
    switch (event.type) {
        case 'note.created':
            return { path: event.payload.path, mtime: event.payload.mtime, bytes: event.payload.bytes, content_sha: event.payload.content_sha };
        case 'note.modified':
            return { path: event.payload.path, mtime: event.payload.mtime, bytes: event.payload.bytes, content_sha: event.payload.content_sha };
        case 'note.deleted':
            return { path: event.payload.path, last_content_sha: event.payload.last_content_sha };
        case 'note.renamed':
            return { from: event.payload.from, to: event.payload.to };
        case 'note.conflicted':
            return { path: event.payload.path, conflict_copy_path: event.payload.conflict_copy_path };
        case 'folder.renamed':
            return { from: event.payload.from, to: event.payload.to };
        case 'note.opened':
            return { path: event.payload.path, dwell: event.payload.dwell };
        case 'chunk.indexed':
            return { path: event.payload.path, ord: event.payload.ord, bs: event.payload.bs, be: event.payload.be, vh: event.payload.vh, cp: event.payload.cp };
        case 'chunk.evicted':
            return { vh: event.payload.vh, path: event.payload.path };
        case 'log.integrity':
            return { detail: event.payload.detail };
        case 'log.checkpoint':
            return { last_seq: event.payload.last_seq, events: event.payload.events, digest: event.payload.digest };
        default: {
            // Compile-time exhaustiveness: unknown event types cannot occur.
            const unreachable: never = event;
            return { detail: `unreachable: ${JSON.stringify(unreachable)}` };
        }
    }
}

/**
 * Serialize one event into one compact JSONL line, '\n'-terminated.
 * Envelope keys in normative order, then payload fields in normative order.
 * Pure: no clock, no I/O, no randomness. Same input ⇒ same line, always,
 * on both machines (F04/P3 depend on this).
 */
export function serializeEvent(event: VaultOverseerEvent): string {
    const payload = payloadInOrder(event);
    const line = {
        v: event.v,
        seq: event.seq,
        ts: event.ts,
        origin: event.origin,
        actor: event.actor,
        type: event.type,
        ...payload,
    };
    return JSON.stringify(line) + '\n';
}
