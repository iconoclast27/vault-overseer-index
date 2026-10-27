// =============================================================================
// Vault Overseer — Heal Scan
// src/eventlog/heal.ts
//
// F03's core: after a mid-flush crash, Tier-1 facts survive (write-through)
// and Tier-2 derivatives re-derive from the vault's own bytes. The heal
// scan is that re-derivation: one rescan, idempotent, self-logging.
//
// Contract (corpus F03, rev C):
//   - Tier-1 events are never touched — facts survive, full stop.
//   - Every note path known from Tier-1 events is re-chunked against
//     PRESENT-DAY file bytes with the PRODUCTION chunker (chunkNote,
//     cp: 2 — migration 2026-10-26, closing the registered debt "heal
//     must migrate off the stub before mixed-cp shards exist").
//     Re-derived chunk.indexed events whose vh already exists in the
//     projection for that path are skipped (idempotence — "the vh
//     collision must not double-emit"). Dedup holds WITHIN a pass as
//     well as against the spine: identical chunks (repeated boilerplate
//     paragraphs) share a vh, and that vh emits exactly once — earned
//     by F03 scenario twin-vh (2026-10-26 errata).
//   - CARVE DISCLOSURE: chunkNote's carves (over-ceiling paragraphs cut
//     at sentence/word/UTF-8 boundaries) are owed log.integrity lines —
//     the chunker's contract says silence disqualifies. Disclosure is
//     TIED TO NOVEL EMISSION: a heal that re-derives only known vhs
//     does not re-complain, or every boot would re-litigate the same
//     carve (the corpse-report lesson, applied). A partial-novelty
//     pass discloses the chunker's full carve list for that note —
//     the carve describes the derivation, not the delta.
//   - P1 VERIFICATION (rev C semantics: MEMBERSHIP): for pre-existing
//     cp:2 records, every recorded vh on a live path must appear among
//     the vhs freshly derived from present-day bytes. The old offset-
//     math re-render (slice + re-hash) is UNSOUND for cp:2 — chain and
//     fm_context are not in the log BY DESIGN (metadata-only output
//     contract), so a recorded span cannot be re-rendered in isolation.
//     Membership is the sound replacement and a SUPERSET of the old
//     check: reordered frontmatter or an inserted heading yields a
//     different vh ⇒ un-derivable ⇒ violation. That is correct, not
//     noisy — different bytes are different content. Eviction of stale
//     records (chunk.evicted) remains parked with the real chunker.
//   - Foreign cp values (anything ≠ 2, including stub-era cp: 0) are
//     skipped WITH DISCLOSURE — a skipped check is a named skip, never
//     a silent one. Recomputing an unknown cp with a known policy
//     would fabricate false P1 violations. cp: 0 stub-era records are
//     forensic truth; they are skipped loudly every heal until a
//     retirement/migration tool exists (registered debt).
//   - Heal logs itself: "buffer window lost, N events re-derived from
//     sha" — only when re-derivation actually emitted something.
//
// Refusal rule: a seq gap halts the projection, so healing across one
// would fabricate completeness against a broken record — heal refuses
// loudly instead (never-fabricate). The F02-repair path (forced heal)
// operates on a CONTIGUOUS spine only.
//
// Migration note 2026-10-22: renderEmbedInput now lives in
// ../chunker/render.ts (single-implementation rule). Superseded for
// this file by the 2026-10-26 migration: heal no longer re-renders
// embed inputs at all — P1 is membership against chunkNote's fresh
// derivation (see above).
//
// Migration note 2026-10-25: the path projection moved to ./projection.ts
// (single-implementation rule — reconcile and the index projection seam
// are incoming consumers) AND changed semantics from ADDITIVE to
// LIVE-SET subtractive: note.deleted and note.renamed-from paths leave
// the examined set. This kills the corpse-noise defect (live-observed
// 2026-10-25: "file absent" reports filed every boot for deleted and
// renamed-away paths — integrity noise wearing the uniform of signal,
// F03 scenario corpse-suppress is the fixture earning this). A path the
// spine says is dead heals to silence; its tombstone IS the record.
//
// Migration note 2026-10-26, amended 2026-10-27: the chunker dependency
// moved from the stub (cp: 0, fixture-grade line packer) to chunkNote
// (cp: 2, production paragraph/heading-chain/frontmatter chunker).
// contentSha imports from render.ts directly. The stub's last consumer
// was F03's legacy-cp0 scenario; rev D (2026-10-27) reseeded it with
// synthetic cp:0 records carrying un-derivable vhs — a foreign-policy
// probe that owes nothing to stub geometry — after which the stub was
// deleted (Phase 4). No code references remain; surviving mentions are
// prose history in fixture ledgers.
//
// Errata note 2026-10-26 (post first contact): within-pass dedup added.
// The emission loop now records each emitted vh into haveVh, so a
// second chunk sharing that vh in the same derivation collides instead
// of emitting a duplicate. Earned by F03 scenario twin-vh; the original
// rev C world (homogeneous filler) hid this because its degenerate
// worlds never exercised a legitimate twin.
//
// Scope notes (owed, visible):
//   - chunk.evicted for stale vhs whose offsets no longer reproduce:
//     parked with the real chunker (sha-drift is its neighbor, F05).
//     A stale vh is detected (P1 violation) but never evicted here.
//   - Missing note files are reported loudly and skipped — eviction
//     is not improvised here.
//   - Carve detail strings are heal-local, not shared with the
//     indexer's emit.ts carveDetail: the indexer lives DOWNSTREAM of
//     the log (it imports eventlog types), so importing it from here
//     would invert the dependency direction. Format keeps the indexer's
//     vocabulary (leading "chunk.carve", key=value pairs) but omits
//     the piece-pairing fields — heal re-derives fresh and cannot
//     honestly pair carves to pieces in a mixed note (the indexer's
//     own pairing is flagged inference there). Declared limitation,
//     not silent divergence.
// =============================================================================

import type { EventLog } from './eventlog.ts';
import { mergeScan, type ByteSource, type ParsedLine } from './reader.ts';
import { projectPaths } from './projection.ts';
import { chunkNote } from '../chunker/chunker.ts';
import { contentSha } from '../chunker/render.ts';

/** Chunk policy heal treats as HOME. Anything else: loud skip, never verify. */
const HOME_CP = 2;

export interface HealResult {
    /** Note paths examined (Tier-1-known). */
    pathsExamined: number;
    /** chunk.indexed events emitted (re-derivation). */
    chunksReemitted: number;
    /** vh collisions skipped — the idempotence counter (within-pass + spine). */
    vhDeduped: number;
    /** Pre-existing chunks failing P1 verification (membership). */
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

    // Projection from the contiguous prefix: LIVE paths (shared
    // projection.ts, subtractive semantics — see migration note) and
    // existing chunk coverage per path.
    const { livePaths: notePaths } = projectPaths(scan.events);
    const existingChunks = new Map<string, ParsedLine[]>();
    for (const e of scan.events) {
        const t = String(e.type);
        if (t === 'chunk.indexed' && typeof e.path === 'string') {
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

        // Re-derive with the PRODUCTION chunker. Determinism (P3/F04)
        // is what makes the fresh derivation comparable to records.
        const derived = chunkNote(bytes);

        // Emit only novel vhs — idempotence gate. haveVh is mutated as
        // we emit, so twins within this pass dedup too (errata 2026-10-26).
        const haveVh = new Set<string>(
            (existingChunks.get(path) ?? []).map((c) => String(c.vh)),
        );
        let emitted = 0;
        for (const chunk of derived.chunks) {
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
            haveVh.add(chunk.vh); // within-pass dedup: twins collide here
            emitted++;
            result.chunksReemitted++;
        }

        if (emitted > 0) {
            await log.reportIntegrity(
                `buffer window lost, ${emitted} events re-derived from sha ` +
                `(path: ${path}, content_sha: ${sha})`,
            );
            // Carve disclosure — only when this pass actually emitted.
            // Silence on an all-dedupe pass is correct idempotence,
            // not a missing report (see contract, carve disclosure).
            for (const carve of derived.carves) {
                await log.reportIntegrity(
                    `chunk.carve path="${path}" reason=${carve.reason} ` +
                    `paragraph_end=${carve.be} pieces=${derived.chunks.length}`,
                );
            }
        }

        // P1 (membership): every recorded vh on this live path must be
        // derivable from present-day bytes. Foreign policy: loud skip.
        // Recomputing an unknown policy's vh would fabricate failures.
        for (const rec of existingChunks.get(path) ?? []) {
            const cp = Number(rec.cp);
            if (cp !== HOME_CP) {
                result.p1Skipped++;
                await log.reportIntegrity(
                    `p1 skipped: unknown chunk policy ` +
                    `(path: ${path}, ord: ${rec.ord}, cp: ${cp}) — ` +
                    `verification owed to the policy's owner`,
                );
                continue;
            }
            const derivable = derived.chunks.some(
                (c) => c.vh === String(rec.vh),
            );
            if (!derivable) {
                result.p1Failures++;
                await log.reportIntegrity(
                    `p1 violation: recorded vh no longer derivable ` +
                    `(path: ${path}, ord: ${rec.ord}, vh: ${rec.vh}) — ` +
                    `chunk eviction owed to the real chunker, not improvised here`,
                );
            }
        }
    }

    return result;
}
