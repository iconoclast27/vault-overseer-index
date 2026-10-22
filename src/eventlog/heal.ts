// =============================================================================
// Vault Overseer — Heal Scan
// src/eventlog/heal.ts
//
// F03's core: after a mid-flush crash, Tier-1 facts survive (write-through)
// and Tier-2 derivatives re-derive from the vault's own bytes. The heal
// scan is that re-derivation: one rescan, idempotent, self-logging.
//
// Contract (corpus F03):
//   - Tier-1 events are never touched — facts survive, full stop.
//   - Every note path known from Tier-1 events is re-chunked against
//     PRESENT-DAY file bytes. Re-derived chunk.indexed events whose vh
//     already exists in the projection for that path are skipped
//     (idempotence — "the vh collision must not double-emit").
//   - Every pre-existing chunk.indexed event is P1-verified against
//     present-day bytes: file_bytes.slice(bs, be) must reproduce a vh
//     equal to the recorded one. Violations are log.integrity, not
//     silent drift.
//   - P1 vh-recompute is only valid for chunks the heal KNOWS how to
//     render. cp: 0 re-renders via the stub shape (empty chain, no fm).
//     Foreign cp values are skipped WITH DISCLOSURE — a skipped check
//     is a named skip, never a silent one. Recomputing an unknown cp
//     with a known policy would fabricate false P1 violations.
//   - Heal logs itself: "buffer window lost, N events re-derived from
//     sha" — only when re-derivation actually emitted something.
//
// Refusal rule: a seq gap halts the projection, so healing across one
// would fabricate completeness against a broken record — heal refuses
// loudly instead (never-fabricate). The F02-repair path (forced heal)
// operates on a CONTIGUOUS spine only.
//
// Migration note 2026-10-22: renderEmbedInput now lives in
// ../chunker/render.ts (single-implementation rule) and takes FOUR
// arguments (prefix, chain, fm, text). This file imports it from there
// and renders with the stub shape (empty chain, null fm) — byte-for-byte
// what the old three-argument stub call produced.
//
// Scope notes (owed, visible):
//   - chunk.evicted for stale vhs whose offsets no longer reproduce:
//     parked with the real chunker (sha-drift is its neighbor, F05).
//   - Missing note files are reported loudly and skipped — eviction
//     is not improvised here.
// =============================================================================

import type { EventLog } from './eventlog.ts';
import { mergeScan, type ByteSource, type ParsedLine } from './reader.ts';
import { chunkStub, contentSha } from '../chunker/stub.ts';
import { embedVh, renderEmbedInput } from '../chunker/render.ts';

export interface HealResult {
    /** Note paths examined (Tier-1-known). */
    pathsExamined: number;
    /** chunk.indexed events emitted (re-derivation). */
    chunksReemitted: number;
    /** vh collisions skipped — the idempotence counter. */
    vhDeduped: number;
    /** Pre-existing chunks failing P1 verification. */
    p1Failures: number;
    /** Pre-existing chunks P1-skipped due to unknown chunk policy. */
    p1Skipped: number;
    /** True if a seq gap refused the heal. */
    refused: boolean;
}

export async function healScan(
    log: EventLog,
    source: ByteSource,
    eventsDir: string,
): Promise<HealResult> {
    const scan = await mergeScan(source, eventsDir);

    // Refusal: healing across a gap fabricates completeness.
    if (scan.gaps.length > 0) {
        for (const g of scan.gaps) {
            await log.reportIntegrity(
                `heal refused: seq gap (origin: ${g.origin}, ` +
                `expected_seq: ${g.expected_seq}, got_seq: ${g.got_seq}) — ` +
                `spine must be contiguous before re-derivation`,
            );
        }
        return { pathsExamined: 0, chunksReemitted: 0, vhDeduped: 0,
            p1Failures: 0, p1Skipped: 0, refused: true };
    }

    // Projection from the contiguous prefix: paths known from Tier-1 note
    // facts, and existing chunk coverage per path.
    const notePaths = new Set<string>();
    const existingChunks = new Map<string, ParsedLine[]>();
    for (const e of scan.events) {
        const t = String(e.type);
        if (t === 'note.created' || t === 'note.modified') {
            if (typeof e.path === 'string') notePaths.add(e.path);
        } else if (t === 'note.renamed') {
            if (typeof e.to === 'string') notePaths.add(e.to);
        } else if (t === 'chunk.indexed' && typeof e.path === 'string') {
            const list = existingChunks.get(e.path) ?? [];
            list.push(e);
            existingChunks.set(e.path, list);
        }
    }

    const result: HealResult = {
        pathsExamined: notePaths.size,
        chunksReemitted: 0,
        vhDeduped: 0,
        p1Failures: 0,
        p1Skipped: 0,
        refused: false,
    };

    for (const path of notePaths) {
        const bytes = await source.readBinary(path);
        if (bytes === undefined) {
            await log.reportIntegrity(
                `heal: file absent (path: ${path}) — chunk eviction owed to the ` +
                `real chunker, not improvised here`,
            );
            continue;
        }
        const sha = contentSha(bytes);

        // Re-derive: chunk present-day bytes, emit only novel vhs.
        const haveVh = new Set<string>(
            (existingChunks.get(path) ?? []).map((c) => String(c.vh)),
        );
        let emitted = 0;
        for (const chunk of chunkStub(bytes)) {
            if (haveVh.has(chunk.vh)) {
                result.vhDeduped++;
                continue;
            }
            await log.appendEvent('plugin', 'chunk.indexed', {
                path,
                ord: chunk.ord,
                bs: chunk.bs,
                be: chunk.be,
                vh: chunk.vh,
                cp: chunk.cp,
            });
            emitted++;
            result.chunksReemitted++;
        }

        if (emitted > 0) {
            await log.reportIntegrity(
                `buffer window lost, ${emitted} events re-derived from sha ` +
                `(path: ${path}, content_sha: ${sha})`,
            );
        }

        // P1: police pre-existing chunks against present-day bytes.
        for (const rec of existingChunks.get(path) ?? []) {
            const cp = Number(rec.cp);
            if (cp !== 0) {
                // Unknown policy: heal cannot faithfully re-render this
                // chunk's embed input, so it cannot verify the vh. Loud
                // skip, never a fabricated failure.
                result.p1Skipped++;
                await log.reportIntegrity(
                    `p1 skipped: unknown chunk policy ` +
                    `(path: ${path}, ord: ${rec.ord}, cp: ${cp}) — ` +
                    `verification owed to the policy's owner`,
                );
                continue;
            }
            const bs = Number(rec.bs);
            const be = Number(rec.be);
            const text = Buffer.from(bytes.subarray(bs, be)).toString('utf-8');
            const recomputed = embedVh(
                renderEmbedInput('search_document:', [], null, text),
            );
            if (recomputed !== String(rec.vh)) {
                result.p1Failures++;
                await log.reportIntegrity(
                    `p1 violation: offsets fail to reproduce text ` +
                    `(path: ${path}, ord: ${rec.ord}, bs: ${bs}, be: ${be})`,
                );
            }
        }
    }

    return result;
}
