// =============================================================================
// Vault Overseer — Chunk → Log bridge (indexer lane)
// src/indexer/emit.ts
//
// First production module of the indexer. Translates the chunker's
// in-memory output into the event log's vocabulary:
//
//     Chunk      → chunk.indexed   (Tier 2, buffered)
//     CarveNote  → log.integrity   (Tier 1, write-through)
//
// WHY THIS MODULE EXISTS (ruling 6, 2026-10-22): the chunker must not
// know the log exists. It returns spans and disclosures; something else
// decides that a span becomes an event. This is that something. Keeping
// the bridge separate leaves the chunker a pure function of bytes (P3
// determinism stays trivially auditable) and leaves the log ignorant of
// chunk internals.
//
// DEPENDENCY SHAPE: this module depends on IndexLogSink — a two-method
// structural interface — not on the concrete EventLog class. EventLog
// satisfies it as-is (verified against src/eventlog/eventlog.ts:
// appendEvent at line 122, reportIntegrity at line 130); fixtures
// satisfy it with a trivial recorder. No adapter plumbing, no mocking
// framework, no I/O anywhere near a unit test.
//
// ORDERING: chunk.indexed is Tier 2 (buffered); log.integrity is Tier 1
// (write-through) and, per EventLog.appendLocked, carries any buffered
// Tier-2 lines ahead of itself so disk order == seq order. Emission
// order therefore cannot corrupt durability — but chunks are emitted
// first anyway, so a reader tailing the shard meets the spans before
// the complaint about them.
// =============================================================================

import type { chunkNote, Chunk } from '../chunker/chunker.ts';
import type { Actor, EventType, VaultOverseerEvent } from '../eventlog/types.ts';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** The chunker's full return value, derived rather than re-declared. */
export type ChunkResult = ReturnType<typeof chunkNote>;

/**
 * A carve disclosure. Derived from ChunkResult rather than imported, so
 * this module never depends on a chunker export that may not exist — if
 * CarveNote gains or loses fields, this follows automatically.
 *
 * Only two fields are relied upon, both exercised by C01 in csuite.ts:
 *   .be     — the ENCLOSING paragraph's end (ruling 5: not the piece end)
 *   .reason — observed value 'over-ceiling-byte-carved'
 */
export type CarveNote = ChunkResult['carves'][number];

/**
 * The narrow slice of EventLog this module needs. EventLog satisfies it
 * structurally; so does a ten-line recorder in a fixture.
 */
export interface IndexLogSink {
    appendEvent<T extends EventType>(
        actor: Actor,
        type: T,
        payload: Extract<VaultOverseerEvent, { type: T }>['payload'],
    ): Promise<void>;
    reportIntegrity(detail: string): Promise<void>;
}

/** What one emit pass did — for logging, and for fixture assertions. */
export interface EmitSummary {
    /** chunk.indexed events written. */
    readonly indexed: number;
    /** log.integrity events written (carves + refused empties). */
    readonly integrity: number;
    /** Chunks refused for having an empty span (should always be 0). */
    readonly refusedEmpty: number;
}

// -----------------------------------------------------------------------------
// Detail-string construction
// -----------------------------------------------------------------------------

/**
 * Build the log.integrity detail string for one carve.
 *
 * Ruling 5 requires the piece span be carried EXPLICITLY, because
 * CarveNote.be is the enclosing paragraph's end — not the end of the
 * piece that was cut. A reader who mistakes one for the other computes
 * a nonsense span. So both numbers appear, named apart.
 *
 * Shape follows the LogIntegrityPayload exemplar ("loud, named,
 * actionable ... key: value"): a leading tag, then key=value pairs.
 *
 * KNOWN LIMITATIONS, both flagged rather than papered over:
 *   1. The path is wrapped in double quotes but embedded quotes are NOT
 *      escaped at v1. A vault path containing '"' yields an ambiguous
 *      detail line. cp-neutral fix when a real vault complains.
 *   2. carve.reason is emitted unquoted, assuming a bare token. Observed
 *      value is 'over-ceiling-byte-carved'; a spaced reason would break
 *      naive key=value parsing downstream.
 */
export function carveDetail(
    path: string,
    carve: CarveNote,
    piece: Chunk | undefined,
    pieceCount: number,
): string {
    const span = piece !== undefined ? `[${piece.bs},${piece.be})` : '[?,?)';
    const ord  = piece !== undefined ? String(piece.ord) : '?';
    return `chunk.carve path="${path}" reason=${carve.reason} `
    + `paragraph_end=${carve.be} piece=${ord} span=${span} pieces=${pieceCount}`;
}

// -----------------------------------------------------------------------------
// Emission
// -----------------------------------------------------------------------------

/**
 * Emit one chunk.indexed event. Returns false — and reports integrity —
 * if the chunk has an empty span. The chunker guarantees this cannot
 * happen, so a refusal here is a loud witness to a broken invariant
 * rather than a silent bad event sitting in the log forever.
 */
export async function emitChunkIndexed(
    sink: IndexLogSink,
    path: string,
    chunk: Chunk,
): Promise<boolean> {
    if (chunk.be <= chunk.bs) {
        await sink.reportIntegrity(
            `chunk.empty path="${path}" ord=${chunk.ord} span=[${chunk.bs},${chunk.be})`,
            );
            return false;
    }
    await sink.appendEvent('plugin', 'chunk.indexed', {
        path,
        ord: chunk.ord,
        bs: chunk.bs,
        be: chunk.be,
        vh: chunk.vh,
        cp: chunk.cp,
    });
    return true;
}

/**
 * Emit a whole chunking pass: every chunk as chunk.indexed, every carve
 * as log.integrity.
 *
 * CARVE↔PIECE PAIRING (inference, flagged): carve[i] is paired with
 * chunks[i]. Grounds: N pieces yield N−1 carves (C01: 4 pieces, 3
 * carves), and the final remainder emits no disclosure — so carve i
 * describes the cut that terminated piece i. That is count arithmetic
 * plus the verified tiling, NOT a field linking the two. If CarveNote
 * ever exposes its own piece ordinal, prefer that over this pairing.
 *
 * ZERO-CHUNK NOTES (C04, declared): a contentless note yields no chunks
 * and no carves, so this emits nothing at all. Silence here is correct
 * and is not a log gap — the note is file-known via note.* facts and
 * simply index-invisible.
 */
export async function emitChunkResult(
    sink: IndexLogSink,
    path: string,
    result: ChunkResult,
): Promise<EmitSummary> {
    let indexed = 0;
    let integrity = 0;
    let refusedEmpty = 0;

    for (const chunk of result.chunks) {
        if (await emitChunkIndexed(sink, path, chunk)) {
            indexed++;
        } else {
            integrity++;
            refusedEmpty++;
        }
    }

    for (let i = 0; i < result.carves.length; i++) {
        const carve = result.carves[i];
        if (carve === undefined) continue;
        await sink.reportIntegrity(
            carveDetail(path, carve, result.chunks[i], result.chunks.length),
        );
        integrity++;
    }

    return { indexed, integrity, refusedEmpty };
}
