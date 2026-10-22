// =============================================================================
// Vault Overseer — Chunker Property Harness (PART 1 OF 2)
// src/fixtures/props.ts
//
// Fast-commit property loop for Chunker Spec v0.1, P1–P6, against the
// real chunker (cp: 1). Runs the seeded hostile corpus from gen-corpus
// — the two modules share NOTHING but bytes: ground truth for chains
// and partitions is computed here by naive re-implementations, and
// two implementations agreeing is the test (P5 doctrine).
//
// Properties in this half:
//   P1 — Offsets reproduce text: [bs, be) slices decode cleanly (no
//        replacement chars — the corpus never emits U+FFFD), re-render
//        through the shared contract reproduces vh exactly, every
//        chunk obeys the ceiling, ord is dense.
//   P2 — Partition: every body byte is claimed exactly once or
//        declined under a declared rule. Audited against an INDEPENDENT
//        line classifier (BOM / frontmatter block / heading lines /
//        blank separators = declinable; everything else must be
//        claimed). Hard-declined bytes (BOM, frontmatter, headings)
//        must NEVER be claimed; blank separators may go either way.
//   P3 — Determinism: same bytes chunked twice ⇒ identical results,
//        bit-for-bit via canonical JSON; corpus regeneration per-doc
//        seeding re-verified (machine-to-machine byte determinism is
//        F04's integration job — here we prove run-to-run).
//
// PART 2 (splice point marked below): P4 atomicity, P5 chain
// correctness (naive walker), P6 fm serialization canonicity, and
// the main() runner. This file is INCOMPLETE without part 2.
//
// Run:  node ./src/fixtures/props.ts
// Node note: erasable TS, .ts import extensions.
// =============================================================================

import { chunkNote, CEILING_BYTES, type Chunk, type ChunkResult } from '../chunker/chunker.ts';
import { embedVh, renderEmbedInput } from '../chunker/render.ts';
import { genCorpus } from './gen-corpus.ts';

const SEED = 20261022;
const DOC_COUNT = 2000;

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail?: string): boolean {
    checks++;
    if (ok) return true;
    failures++;
    console.log(`[FAIL] ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
    return false;
}

/** Compact, deterministic serialization for bit-comparison (P3). */
function canon(res: ChunkResult): string {
    return JSON.stringify(res);
}

function lineEnd(bytes: Uint8Array, from: number): number {
    const nl = bytes.indexOf(0x0a, from);
    return nl === -1 ? bytes.length : nl + 1;
}

// -----------------------------------------------------------------------------
// P1 — Offsets reproduce text (the killer invariant)
// -----------------------------------------------------------------------------

function p1OffsetsReproduceText(docs: readonly Uint8Array[]): void {
    let chunkTotal = 0;
    for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        const res = chunkNote(doc);
        chunkTotal += res.chunks.length;
        let ok = true;
        for (const c of res.chunks) {
            if (!(0 <= c.bs && c.bs < c.be && c.be <= doc.length)) {
                ok = check(`P1 bounds (doc ${i}, ord ${c.ord})`,
                           false, `bs=${c.bs} be=${c.be} len=${doc.length}`);
                if (!ok) break;
            }
            if (c.be - c.bs > CEILING_BYTES) {
                ok = check(`P1 ceiling (doc ${i}, ord ${c.ord})`,
                           false, `len=${c.be - c.bs} > ${CEILING_BYTES}`);
                if (!ok) break;
            }
            const text = Buffer.from(doc.subarray(c.bs, c.be)).toString('utf-8');
            // Misaligned byte offsets surface as U+FFFD on decode; the
            // corpus contains none, so any replacement char is a lie.
            if (text.includes('\uFFFD')) {
                ok = check(`P1 utf-8 alignment (doc ${i}, ord ${c.ord})`,
                           false, `slice [${c.bs},${c.be}) decoded with replacement chars`);
                           if (!ok) break;
            }
            const vh = embedVh(renderEmbedInput('search_document:', c.chain, res.fm, text));
            if (vh !== c.vh) {
                ok = check(`P1 vh reproduction (doc ${i}, ord ${c.ord})`,
                           false, `recorded=${c.vh} recomputed=${vh}`);
                if (!ok) break;
            }
        }
        // Dense ord sequence, zero-length chunks never emitted (C04 shape).
        const dense = res.chunks.every((c: Chunk, k: number) => c.ord === k && c.be > c.bs);
        check(`P1 ord dense + non-empty (doc ${i})`, dense,
              res.chunks.map((c: Chunk) => c.ord).join(','));
    }
    console.log(`[P1 ] scanned ${chunkTotal} chunks over ${docs.length} docs`);
}

// -----------------------------------------------------------------------------
// P2 — Partition under declared rules (independent line classifier)
// -----------------------------------------------------------------------------

/** Byte classification for the audit: 0 must-claim, 1 optional, 2 never-claim. */
const MUST_CLAIM = 0;
const OPTIONAL = 1;   // blank separator lines (outside fences)
const FORBIDDEN = 2;  // BOM, frontmatter block, heading lines

const HEADING_RE = /^(#{1,6})(?:\s+(.*))?$/;

/**
 * Naive, independent classifier. Deliberately shares no code or logic
 * table with chunker.ts beyond the SPEC's declared decline rules. If
 * these two disagree, one of them is wrong and the red names the doc.
 */
function classifyBytes(doc: Uint8Array): Uint8Array {
    const flags = new Uint8Array(doc.length);
    let start = 0;
    if (doc.length >= 3 &&
        doc[0] === 0xef && doc[1] === 0xbb && doc[2] === 0xbf) {
        flags.fill(FORBIDDEN, 0, 3);
    start = 3;
        }
        // Frontmatter: first line '---' opens IF a later line closes it.
        const firstLe = lineEnd(doc, start);
        const firstLine = Buffer.from(doc.subarray(start, firstLe)).toString('utf-8').trim();
        let bodyStart = start;
        if (firstLine === '---') {
            let i = firstLe;
            let closed = false;
            while (i < doc.length) {
                const le = lineEnd(doc, i);
                const t = Buffer.from(doc.subarray(i, le)).toString('utf-8').trim();
                if (t === '---') {
                    flags.fill(FORBIDDEN, start, le);
                    bodyStart = le;
                    closed = true;
                    break;
                }
                i = le;
            }
            if (!closed) bodyStart = start; // lone opener: whole file is body
        }
        let inFence = false;
        let i = bodyStart;
        while (i < doc.length) {
            const le = lineEnd(doc, i);
            const t = Buffer.from(doc.subarray(i, le)).toString('utf-8').trim();
            if (inFence) {
                // fence content: must-claim, blank or not
                if (t.startsWith('```')) inFence = false;
                flags.fill(MUST_CLAIM, i, le);
            } else if (t.startsWith('```')) {
                inFence = true;
                flags.fill(MUST_CLAIM, i, le);
            } else if (t === '') {
                flags.fill(OPTIONAL, i, le);
            } else if (HEADING_RE.test(t)) {
                flags.fill(FORBIDDEN, i, le);
            } else {
                flags.fill(MUST_CLAIM, i, le);
            }
            i = le;
        }
        return flags;
}

function p2Partition(docs: readonly Uint8Array[]): void {
    for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        const res = chunkNote(doc);
        const flags = classifyBytes(doc);

        // Ordered, non-overlapping: bs[i] >= be[i-1]; within doc bounds.
        let mono = true;
        let prevBe = 0;
        for (const c of res.chunks) {
            if (c.bs < prevBe) { mono = false; break; }
            prevBe = c.be;
        }
        check(`P2 ordered/non-overlapping (doc ${i})`, mono,
              res.chunks.map((c: Chunk) => `[${c.bs},${c.be})`).join(''));

              // Coverage counts per byte; violations counted, first few reported.
              const cover = new Int8Array(doc.length);
              let badClaim = 0, badMiss = 0, badOverlap = 0;
              for (const c of res.chunks) {
                  for (let b = c.bs; b < c.be; b++) {
                      if (flags[b] === FORBIDDEN) badClaim++;
                      if (cover[b] === 1) badOverlap++;
                      cover[b] = 1;
                  }
              }
              for (let b = 0; b < doc.length; b++) {
                  if (flags[b] === MUST_CLAIM && cover[b] === 0) badMiss++;
              }
              check(`P2 no forbidden bytes claimed (doc ${i})`, badClaim === 0, `${badClaim} bytes`);
              check(`P2 no byte claimed twice (doc ${i})`, badOverlap === 0, `${badOverlap} bytes`);
              check(`P2 every content byte claimed (doc ${i})`, badMiss === 0, `${badMiss} bytes`);
    }
    console.log('[P2 ] partition audit complete');
}

// -----------------------------------------------------------------------------
// P3 — Determinism (run-to-run, in-process)
// -----------------------------------------------------------------------------

function p3Determinism(docs: readonly Uint8Array[]): void {
    let mismatches = 0;
    for (let i = 0; i < docs.length; i++) {
        const a = canon(chunkNote(docs[i]));
        const b = canon(chunkNote(docs[i]));
        if (a !== b) mismatches++;
    }
    check(`P3 same-bytes-twice identical`, mismatches === 0, `${mismatches} docs`);

    // Corpus regeneration: doc i from the whole corpus equals doc i alone.
    let regenBad = 0;
    for (let i = 0; i < Math.min(docs.length, 50); i++) {
        const solo = genCorpus(1, SEED ^ i)[0];
        if (Buffer.compare(Buffer.from(solo), Buffer.from(docs[i])) !== 0) regenBad++;
    }
    check(`P3 per-doc regeneration (50-doc sample)`, regenBad === 0, `${regenBad} docs`);

    // Same input through a SECOND corpus instance with the same seed:
    // the corpus itself must be deterministic before chunking is.
    const docsAgain = genCorpus(DOC_COUNT, SEED);
    let corpusBad = 0;
    for (let i = 0; i < docs.length; i++) {
        if (Buffer.compare(Buffer.from(docsAgain[i]), Buffer.from(docs[i])) !== 0) {
            corpusBad++;
        }
    }
    check(`P3 corpus regeneration identical`, corpusBad === 0, `${corpusBad} docs`);
    console.log('[P3 ] determinism audit complete');
}
import { serializeFmContext } from '../chunker/render.ts';

// -----------------------------------------------------------------------------
// P4 — Atomicity (structural spans are never straddled)
// Rewritten 2026-10-22: stateful span collection (closing fences are only
// recognizable WITH fence state), violation defined as a chunk boundary
// falling strictly inside a span — whole spans inside merged chunks are
// legal, carve pieces inside over-ceiling spans are legal per the ratified
// carve-anyway ruling.
// -----------------------------------------------------------------------------

interface Span { start: number; end: number; }

/**
 * Independent structural-span collector: fence spans (opening delimiter
 * through closing delimiter, or to EOF when unclosed — C02's rule) and
 * table spans (maximal contiguous table-row runs). Shares nothing with
 * chunker.ts; disagreement names a doc, not a mood.
 */
function structuralSpans(doc: Uint8Array): Span[] {
    const spans: Span[] = [];
    let start = doc.length >= 3 &&
    doc[0] === 0xef && doc[1] === 0xbb && doc[2] === 0xbf ? 3 : 0;
    const firstLe = lineEnd(doc, start);
    const firstLine = Buffer.from(doc.subarray(start, firstLe)).toString('utf-8').trim();
    if (firstLine === '---') {
        let i = firstLe;
        while (i < doc.length) {
            const le = lineEnd(doc, i);
            const t = Buffer.from(doc.subarray(i, le)).toString('utf-8').trim();
            if (t === '---') { start = le; break; }
            i = le;
        }
    }
    let inFence = false;
    let fenceStart = 0;
    let tableStart = -1;
    let i = start;
    while (i < doc.length) {
        const le = lineEnd(doc, i);
        const t = Buffer.from(doc.subarray(i, le)).toString('utf-8').trim();
        if (inFence) {
            if (t.startsWith('```')) {
                spans.push({ start: fenceStart, end: le });
                inFence = false;
            }
        } else if (t.startsWith('```')) {
            inFence = true;
            fenceStart = i;
        } else if (t.startsWith('|')) {
            if (tableStart === -1) tableStart = i;
        } else {
            if (tableStart !== -1) {
                spans.push({ start: tableStart, end: i });
                tableStart = -1;
            }
        }
        i = le;
    }
    if (inFence) spans.push({ start: fenceStart, end: doc.length });
    if (tableStart !== -1) spans.push({ start: tableStart, end: doc.length });
    return spans;
}

function p4Atomicity(docs: readonly Uint8Array[]): void {
    let violations = 0;
    const samples: string[] = [];
    for (let di = 0; di < docs.length; di++) {
        const doc = docs[di];
        const res = chunkNote(doc);
        const spans = structuralSpans(doc);
        for (const c of res.chunks) {
            for (const s of spans) {
                const overlaps = c.bs < s.end && s.start < c.be;
                if (!overlaps) continue;
                const spanInsideChunk = c.bs <= s.start && s.end <= c.be;
                const chunkInsideSpan = s.start <= c.bs && c.be <= s.end;
                const carved = s.end - s.start > CEILING_BYTES;
                if (!(spanInsideChunk || (chunkInsideSpan && carved))) {
                    violations++;
                    if (samples.length < 5) samples.push(
                        `doc ${di}, ord ${c.ord}: chunk=[${c.bs},${c.be}) ` +
                        `span=[${s.start},${s.end}) len=${s.end - s.start}`);
                }
            }
        }
    }
    for (const s of samples) console.log(`  SAMPLE: ${s}`);
    check(`P4 no structural straddles`, violations === 0, `${violations} violations`);
    console.log('[P4 ] atomicity audit complete');
}

// -----------------------------------------------------------------------------
// P5 — Chain correctness (naive independent walker)
// Rewritten 2026-10-22: frontmatter detection (absent fm no longer starves
// every chain to []), fence tracking (headings inside fences don't push the
// stack), and a line-start binary search replacing the inexcusable modulo
// arithmetic. The chunker and this walker share nothing but the spec.
// -----------------------------------------------------------------------------

function naiveChains(doc: Uint8Array): { starts: number[]; chains: string[][] } {
    const starts: number[] = [];
    const chains: string[][] = [];
    const stack: string[] = [];
    let i = doc.length >= 3 &&
    doc[0] === 0xef && doc[1] === 0xbb && doc[2] === 0xbf ? 3 : 0;
    const firstLe = lineEnd(doc, i);
    const firstLine = Buffer.from(doc.subarray(i, firstLe)).toString('utf-8').trim();
    if (firstLine === '---') {
        let fmEnd = -1;
        let j = firstLe;
        while (j < doc.length) {
            const le = lineEnd(doc, j);
            const t = Buffer.from(doc.subarray(j, le)).toString('utf-8').trim();
            if (t === '---') { fmEnd = le; break; }
            j = le;
        }
        if (fmEnd !== -1) i = fmEnd; // lone opener with no closer: no fm
    }
    let inFence = false;
    while (i < doc.length) {
        const le = lineEnd(doc, i);
        const t = Buffer.from(doc.subarray(i, le))
        .toString('utf-8').replace(/\r$/, '').trim();
        if (inFence) {
            if (t.startsWith('```')) inFence = false;
        } else if (t.startsWith('```')) {
            inFence = true;
        } else {
            const h = HEADING_RE.exec(t);
            if (h !== null) {
                stack.length = Math.min(stack.length, h[1].length - 1);
                stack.push((h[2] ?? '').trim());
            }
        }
        starts.push(i);
        chains.push([...stack]);
        i = le;
    }
    return { starts, chains };
}

function p5ChainCorrectness(docs: readonly Uint8Array[]): void {
    let mismatches = 0;
    const samples: string[] = [];
    for (let di = 0; di < docs.length; di++) {
        const doc = docs[di];
        const res = chunkNote(doc);
        const { starts, chains } = naiveChains(doc);
        for (const c of res.chunks) {
            // c.bs starts at a line boundary (first byte of the chunk's
            // first paragraph's first line). Carve pieces 1+ start
            // mid-line; the next line start carries the same stack.
            let lo = 0, hi = starts.length - 1;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (starts[mid] < c.bs) lo = mid + 1; else hi = mid;
            }
            const naive = chains[lo];
            const eq = JSON.stringify(c.chain) === JSON.stringify(naive);
            if (!eq) {
                mismatches++;
                if (samples.length < 10) samples.push(
                    `doc ${di}, ord ${c.ord}: ` +
                    `chunk=${JSON.stringify(c.chain)} naive=${JSON.stringify(naive)}`);
            }
        }
    }
    for (const s of samples) console.log(`  SAMPLE: ${s}`);
    check(`P5 chain correctness`, mismatches === 0, `${mismatches} mismatches`);
    console.log('[P5 ] chain audit complete');
}

// -----------------------------------------------------------------------------
// P6 — Idempotent vh + fm serialization canonicity
// Rewritten 2026-10-22: the dynamic-import variant raced process.exit()
// and never ran — a silent skip inside the R5 machinery. Static import,
// synchronous checks. Key permutation only: array element order is
// deliberately NOT canonicalized (bytes are law; ['x','y'] ≠ ['y','x']).
// -----------------------------------------------------------------------------

function p6VhIdempotenceAndCanonicity(docs: readonly Uint8Array[]): void {
    let vhMismatch = 0;
    for (let i = 0; i < docs.length; i++) {
        const res = chunkNote(docs[i]);
        for (const c of res.chunks) {
            const text = Buffer.from(docs[i].subarray(c.bs, c.be)).toString('utf-8');
            const vh1 = embedVh(renderEmbedInput('search_document:', c.chain, res.fm, text));
            const vh2 = embedVh(renderEmbedInput('search_document:', c.chain, res.fm, text));
            if (vh1 !== vh2) vhMismatch++;
        }
    }
    check(`P6 vh idempotent (render twice)`, vhMismatch === 0, `${vhMismatch} mismatches`);

    const a = serializeFmContext({ aliases: ['a'], description: 'd', tags: ['x'], type: 'note' });
    const b = serializeFmContext({ type: 'note', tags: ['x'], description: 'd', aliases: ['a'] });
    check(`P6 fm_context key permutation canonical`, a === b, `${a} vs ${b}`);
    check(`P6 fm_context empty serializes null`, serializeFmContext({}) === null);
    console.log('[P6 ] vh canonicity audit complete');
}

// -----------------------------------------------------------------------------
// main — run all six properties, print verdict
// -----------------------------------------------------------------------------

function main(): void {
    const corpus = genCorpus(DOC_COUNT, SEED);
    console.log(`props.ts harness: ${DOC_COUNT} docs, seed ${SEED}\n`);

    p1OffsetsReproduceText(corpus);
    p2Partition(corpus);
    p3Determinism(corpus);
    p4Atomicity(corpus);
    p5ChainCorrectness(corpus);
    p6VhIdempotenceAndCanonicity(corpus);

    console.log('');
    if (failures === 0) {
        console.log(`PROPS: ALL GREEN (${checks} checks, ${DOC_COUNT} docs)`);
    } else {
        console.log(`PROPS: ${failures} RED (out of ${checks} checks)`);
    }
}

main();
process.exitCode = failures === 0 ? 0 : 1;
