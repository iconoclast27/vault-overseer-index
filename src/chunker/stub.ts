// =============================================================================
// Vault Overseer — Chunker Stub (patched 2026-10-22)
// src/chunker/stub.ts
//
// Behavior unchanged: whole-line packing, cp: 0, byte-honest spans.
// CHANGE: renderEmbedInput/sha16/contentSha now live in ./render.ts
// (single-implementation rule). The stub calls them with an empty chain
// and null fm — byte-identical output to its former private copy, so
// every cp:0 vh is preserved. sha16/contentSha re-exported for
// downstream imports (f03.ts) — no consumer edits required.
//
// The stub is now formally dead code walking: the real chunker
// (cp: 1, Chunker Spec v0.1 P1–P6) succeeds it. Retire nothing yet —
// F03's re-derivation clause still cites this geometry, and mixed-cp
// history in the wild means old shards carry cp: 0 forensics.
// =============================================================================

import { embedVh, renderEmbedInput } from './render.ts';

export { contentSha, sha16 } from './render.ts';

/** Chunk policy version: 0 = stub. */
export const STUB_CP = 0 as const;

/** Stub byte budget per chunk (target, not guarantee — final chunk may be short). */
export const STUB_CHUNK_BYTES = 512;

export interface StubChunk {
    ord: number;
    bs: number;
    be: number;
    /** vh of the rendered embed input for this chunk. */
    vh: string;
    cp: typeof STUB_CP;
}

/**
 * Deterministic line-packing chunker. Splits raw file bytes on 0x0A,
 * greedily packs whole lines into <= STUB_CHUNK_BYTES spans, records
 * byte-exact [bs, be) per chunk. Chunk text === file_bytes.slice(bs, be)
 * BY CONSTRUCTION — which is exactly what F03's P1 verification probes.
 */
export function chunkStub(fileBytes: Uint8Array): StubChunk[] {
    const chunks: StubChunk[] = [];
    let spanStart = 0;
    let spanEnd = 0;
    let spanBytes = 0;

    const flush = (): void => {
        if (spanBytes === 0) return;
        const text = Buffer.from(fileBytes.subarray(spanStart, spanEnd)).toString('utf-8');
        chunks.push({
            ord: chunks.length,
            bs: spanStart,
            be: spanEnd,
            vh: embedVh(renderEmbedInput('search_document:', [], null, text)),
                    cp: STUB_CP,
        });
        spanBytes = 0;
    };

    // Walk whole lines (including their terminating 0x0A, so be spans
    // the newline — text reproduces with it, byte-faithfully).
    let i = 0;
    while (i < fileBytes.length) {
        const nl = fileBytes.indexOf(0x0a, i);
        const lineEnd = nl === -1 ? fileBytes.length : nl + 1;
        const lineLen = lineEnd - i;
        if (spanBytes > 0 && spanBytes + lineLen > STUB_CHUNK_BYTES) flush();
        if (spanBytes === 0) spanStart = i;
        i = lineEnd;
        spanEnd = lineEnd;
        spanBytes += lineLen;
    }
    flush();

    return chunks;
}
