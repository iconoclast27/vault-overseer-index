// =============================================================================
// Vault Overseer — Real Chunker (Chunker Spec v0.1, P1–P6)
// src/chunker/chunker.ts
//
// Chunk policy version 2: paragraph-level, heading-chained,
// frontmatter-stamped. Supersedes the stub's geometry entirely —
// mixed cp in a projection means re-chunk required (schema).
//
// CHANGELOG cp: 1 → 2 (2026-10-22, finding B / C02(b)):
//   walkParagraphs: a fence opener now ALWAYS closes the in-flight
//   paragraph and begins a new atomic paragraph at the fence line.
//   Behaviour-preserving for every blank-separated-fence document
//   (the corpus entire); observable only for ADJACENT fences, where
//   cp: 1 could absorb the fence into a text paragraph and then
//   sentence-split through fence delimiters on over-ceiling
//   paragraphs — a P4 violation masked by a polite corpus (finding
//   B: gen-corpus always pushes blankLines before fences, so the
//   absorption branch was never exercised by P1–P6).
//
// P2 DECLARED RULES — what body bytes are claimed vs. declined.
// The property harness (P2) enforces exactly this list; amending it
// is a cp bump, not a comment edit:
//   CLAIMED   every non-heading body paragraph's content bytes and
//             line terminators, by exactly one chunk
//   CLAIMED   blank-line separator runs BETWEEN paragraphs merged
//             into one chunk (absorbed with the merge)
//   DECLINED  BOM bytes (0xEF 0xBB 0xBF), when present
//   DECLINED  the frontmatter block: opening '---' line through the
//             closing '---' line, inclusive (stamped into fm_context,
//             never into chunk offsets)
//   DECLINED  heading lines (their content travels in the chain)
//   DECLINED  blank-line separator runs between chunks that are NOT
//             merged (a gap between consecutive chunk byte-spans)
// No other decline rules exist. Every body byte is claimed or
// declined under exactly one of the above.
//
// DECLARED SIMPLIFICATIONS (v2, fixture-bait):
//   - Paragraph atomicity is judged by its FIRST line: a paragraph
//     starting with '|' or '```' is atomic (table/fence). (cp: 2)
//     A fence opener ALWAYS closes the current paragraph and starts
//     a new atomic one — a fence is never absorbed into a text
//     paragraph, which would let sentence-splitting cut through
//     fence delimiters (the finding-B hole).
//   - Frontmatter heuristic: a first line of '---' OPENS frontmatter
//     only if a later line is exactly '---'. A lone opening '---'
//     with no closer means NO frontmatter; the whole file is body.
//   - Sentence terminators: ASCII '. ! ?' and CJK '。！？' followed by
//     whitespace or end-of-span. No ellipsis, no quotes handling.
//   - Over-ceiling ATOMIC paragraphs (giant fences/tables) byte-carve
//     at UTF-8-aligned offsets with disclosure — sentences do not
//     split fences.
//   - Heading text is trimmed verbatim; ATX closing '#' runs are NOT
//     stripped. # Title #  keeps its trailing hashes in the chain.
//
// Budget: TARGET 2048 bytes / CEILING 3072 bytes (byte proxy for
// ~512/~768 tokens at nomic's 8192 ctx; token-exact fitting is a
// future cp bump if measurement demands — Spec parked decision 2).
//
// Over-ceiling handling (Spec Step 4 + parked decision 1, ratified
// carve-anyway): sentence split → word split → UTF-8-aligned byte
// carve. Never truncates. Every carve is disclosed via `carves`
// for the indexer to emit as log.integrity (silence disqualifies).
//
// Determinism (P3/F04): pure function; same bytes ⇒ same chunks
// bit-for-bit, machine-independent. No clock, no locale, no random.
//
// Output contract: {path, ord, bs, be, vh, cp} per chunk into the
// log (metadata only); chain rides along here for P5 verification
// and citation UI — the log never stores it.
//
// Node note: node:crypto via render.ts, erasable TS, .ts imports.
// =============================================================================

import {
    embedVh, parseFmContext, renderEmbedInput, type FmContext,
} from './render.ts';

/** Chunk policy version owned by THIS chunker. */
export const CHUNKER_CP = 2 as const;

/** Soft target: adjacent paragraphs merge up to this. Bytes. */
export const TARGET_BYTES = 2048;

/** Hard ceiling: nothing larger ever emits, except nothing. Bytes. */
export const CEILING_BYTES = 3072;

export interface Chunk {
    ord: number;
    /** Inclusive byte start of first paragraph's first byte. */
    bs: number;
    /** Exclusive byte end of last paragraph's last byte. [bs, be). */
    be: number;
    /** vh of the rendered embed input (prefix + chain + fm + text). */
    vh: string;
    cp: typeof CHUNKER_CP;
    /** Heading chain at the chunk's position. Diagnostic/citation. */
    chain: readonly string[];
}

export interface CarveNote {
    bs: number;
    be: number;
    reason: 'over-ceiling-byte-carved';
}

export interface ChunkResult {
    chunks: Chunk[];
    /** Disclosures owed to log.integrity. May be empty; never silent. */
    carves: CarveNote[];
    /** True if a UTF-8 BOM was found and declined. */
    hadBom: boolean;
    /** The fm_context used in every vh — null when absent/degenerate. */
    fm: FmContext | null;
}

// -----------------------------------------------------------------------------
// Byte-level line walk — offsets are ALWAYS raw byte positions into
// the file as stored. Decoding happens per-line for structure
// decisions only; string indices never touch offset math (C03).
// -----------------------------------------------------------------------------

const BOM = [0xef, 0xbb, 0xbf];

function lineEnd(bytes: Uint8Array, from: number): number {
    const nl = bytes.indexOf(0x0a, from);
    return nl === -1 ? bytes.length : nl + 1;
}

function decodeLine(bytes: Uint8Array, bs: number, be: number): string {
    // Decode with terminator, then strip a trailing CR for comparison
    // only. Offsets keep the CR; CRLF straddling is faithful.
    return Buffer.from(bytes.subarray(bs, be)).toString('utf-8').replace(/\r$/, '');
}

function isWhitespaceByte(b: number): boolean {
    return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
}

// -----------------------------------------------------------------------------
// Frontmatter partition (Step 1)
// -----------------------------------------------------------------------------

interface FmPartition {
    fm: FmContext | null;
    bodyStart: number;
}

function partitionFrontmatter(bytes: Uint8Array, start: number): FmPartition {
    const firstLe = lineEnd(bytes, start);
    if (decodeLine(bytes, start, firstLe).trim() !== '---') {
        return { fm: null, bodyStart: start };
    }
    let i = firstLe;
    while (i < bytes.length) {
        const le = lineEnd(bytes, i);
        if (decodeLine(bytes, i, le).trim() === '---') {
            const blockText = Buffer.from(bytes.subarray(firstLe, i)).toString('utf-8');
            // Degenerate (C05) parses down to {} ⇒ null fm. Never throws.
            return { fm: parseFmContext(blockText), bodyStart: le };
        }
        i = le;
    }
    // No closing delimiter: declared simplification — no frontmatter.
    return { fm: null, bodyStart: start };
}

// -----------------------------------------------------------------------------
// Paragraph segmentation + heading chains (Steps 2–3)
// -----------------------------------------------------------------------------

type ParaKind = 'text' | 'atomic';

interface Para {
    bs: number;
    be: number;
    chain: string[];
    /** Paragraph follows a heading line → chunks never span the boundary. */
    afterHeading: boolean;
    kind: ParaKind;
}

const HEADING_RE = /^(#{1,6})(?:\s+(.*))?$/;

/**
 * Walk body lines, carrying fence state across them. Blank lines end
 * paragraphs OUTSIDE fences; inside a fence they are content. A
 * paragraph's kind is set by its first line ('|' or '```' ⇒ atomic).
 *
 * (cp: 2) A fence opener ALWAYS closes the current paragraph and
 * starts a new atomic paragraph at the fence line — never absorbed
 * into a text paragraph (finding B: absorption allowed over-ceiling
 * text paragraphs to sentence-split through fence delimiters).
 */
function walkParagraphs(bytes: Uint8Array, bodyStart: number): Para[] {
    const paras: Para[] = [];
    let chain: string[] = [];
    let inFence = false;
    let afterHeading = true; // document start acts as a section boundary
    let cur: Para | null = null;

    const close = (): void => {
        if (cur !== null) {
            paras.push(cur);
            cur = null;
        }
    };

    let i = bodyStart;
    while (i < bytes.length) {
        const le = lineEnd(bytes, i);
        const t = decodeLine(bytes, i, le).trim();
        const startsFence = t.startsWith('```');

        if (inFence) {
            if (startsFence) inFence = false;
            cur!.be = le;
        } else if (startsFence) {
            // (cp: 2) Fence opener: close any in-flight paragraph and
            // begin a fresh atomic one at the fence delimiter line.
            inFence = true;
            close();
            cur = { bs: i, be: le, chain: [...chain], afterHeading, kind: 'atomic' };
            afterHeading = false;
        } else if (t === '') {
            close(); // separator; afterHeading intentionally survives
        } else {
            const h = HEADING_RE.exec(t);
            if (h !== null) {
                close();
                const level = h[1].length;
                chain = chain.slice(0, level - 1);
                chain.push((h[2] ?? '').trim()); // verbatim minus trim (declared)
                afterHeading = true;
            } else if (cur !== null) {
                cur.be = le;
            } else {
                const kind: ParaKind = t.startsWith('|') ? 'atomic' : 'text';
                cur = { bs: i, be: le, chain: [...chain], afterHeading, kind };
                afterHeading = false;
            }
        }
        i = le;
    }
    close();
    return paras;
}

// -----------------------------------------------------------------------------
// Over-ceiling splitting (Step 4): sentences → words → UTF-8 carve.
// All functions below operate on raw byte ranges and return PIECE
// LENGTHS that tile [s, e) exactly. Never truncate, never overlap.
// -----------------------------------------------------------------------------

/** ASCII '. ! ?' and CJK '。！？' followed by whitespace or span end. */
function sentenceBoundaries(bytes: Uint8Array, s: number, e: number): number[] {
    const out: number[] = [];
    for (let i = s; i < e; i++) {
        const b = bytes[i];
        let termLen = 0;
        if (b === 0x2e || b === 0x21 || b === 0x3f) termLen = 1;
        else if (b === 0xe3 && bytes[i + 1] === 0x80 && bytes[i + 2] === 0x82) termLen = 3; // 。
        else if (b === 0xef && bytes[i + 1] === 0xbc &&
            (bytes[i + 2] === 0x81 || bytes[i + 2] === 0x9f)) termLen = 3; // ！？
            if (termLen === 0) continue;
            const after = i + termLen;
        if (after >= e || isWhitespaceByte(bytes[after])) {
            out.push(after);
            i = after - 1;
        }
    }
    return out;
}

/** Positions after whitespace runs — word ends, in order. */
function wordBoundaries(bytes: Uint8Array, s: number, e: number): number[] {
    const out: number[] = [];
    let i = s;
    while (i < e) {
        if (isWhitespaceByte(bytes[i])) {
            let j = i;
            while (j < e && isWhitespaceByte(bytes[j])) j++;
            if (j < e) out.push(j);
            i = j;
        } else {
            i++;
        }
    }
    return out;
}

/** Largest offset ≤ limit that starts a UTF-8 character (never mid-codepoint). */
function utf8SafeCut(bytes: Uint8Array, limit: number): number {
    while ((bytes[limit] & 0xc0) === 0x80) limit--;
    return limit;
}

type Level = 'sentence' | 'word' | 'byte';

/**
 * Greedy unit packing into pieces ≤ CEILING, aiming ≤ TARGET when
 * boundaries allow. A unit larger than the ceiling escalates one
 * level: sentence → word → byte carve (with disclosure). Atomic
 * paragraphs enter at 'byte' level directly (declared rule: fences
 * do not sentence-split).
 */
function splitRange(
    bytes: Uint8Array,
    s: number,
    e: number,
    level: Level,
    carves: CarveNote[],
): number[] {
    const lengths: number[] = [];

    if (level === 'byte') {
        let pos = s;
        while (e - pos > CEILING_BYTES) {
            const cut = utf8SafeCut(bytes, pos + CEILING_BYTES);
            lengths.push(cut - pos);
            carves.push({ bs: pos, be: e, reason: 'over-ceiling-byte-carved' });
            pos = cut;
        }
        if (e > pos) lengths.push(e - pos);
        return lengths;
    }

    const units = level === 'sentence'
    ? sentenceBoundaries(bytes, s, e)
    : wordBoundaries(bytes, s, e);
    const all = [...units];
    if (all[all.length - 1] !== e) all.push(e);

    let pieceStart = s;
    let prev = s;
    for (const k of all) {
        const unitLen = k - prev;
        if (unitLen > CEILING_BYTES) {
            // Close the in-flight piece, escalate this unit a level.
            if (prev > pieceStart) lengths.push(prev - pieceStart);
            lengths.push(...splitRange(bytes, prev, k, level === 'sentence' ? 'word' : 'byte', carves));
            pieceStart = k;
        } else if (k - pieceStart > TARGET_BYTES && prev > pieceStart) {
            // Adding this unit would overflow the target: close first.
            lengths.push(prev - pieceStart);
            pieceStart = prev;
        }
        prev = k;
    }
    if (e > pieceStart) lengths.push(e - pieceStart);
    return lengths;
}

// -----------------------------------------------------------------------------
// Assembly (Steps 4–6)
// -----------------------------------------------------------------------------

interface Draft { bs: number; be: number; chain: string[]; }

/**
 * Chunk a note's raw file bytes. Pure, deterministic, never throws:
 * hostile input degrades to more chunks, not to failure.
 */
export function chunkNote(fileBytes: Uint8Array): ChunkResult {
    const hadBom = fileBytes.length >= 3 &&
    fileBytes[0] === BOM[0] && fileBytes[1] === BOM[1] && fileBytes[2] === BOM[2];
    const start = hadBom ? 3 : 0;
    const { fm, bodyStart } = partitionFrontmatter(fileBytes, start);

    const paras = walkParagraphs(fileBytes, bodyStart);
    const carves: CarveNote[] = [];
    const drafts: Draft[] = [];
    let cur: Draft | null = null;

    for (const p of paras) {
        const plen = p.be - p.bs;

        if (plen > CEILING_BYTES) {
            // Over-ceiling paragraph: standalone pieces, never merged
            // with neighbours. Escalates per declared rules.
            if (cur !== null) { drafts.push(cur); cur = null; }
            let pos = p.bs;
            for (const len of splitRange(
                fileBytes, p.bs, p.be, p.kind === 'atomic' ? 'byte' : 'sentence', carves,
            )) {
                drafts.push({ bs: pos, be: pos + len, chain: p.chain });
                pos += len;
            }
            continue;
        }

        // Chunks never span heading boundaries (Step 4).
        if (p.afterHeading && cur !== null) {
            drafts.push(cur);
            cur = null;
        }

        if (cur !== null && p.be - cur.bs <= TARGET_BYTES) {
            cur.be = p.be; // merge — separator bytes absorbed
        } else {
            if (cur !== null) drafts.push(cur);
            cur = { bs: p.bs, be: p.be, chain: p.chain };
        }
    }
    if (cur !== null) drafts.push(cur);

    const chunks: Chunk[] = drafts.map((d, ord) => {
        const text = Buffer.from(fileBytes.subarray(d.bs, d.be)).toString('utf-8');
        return {
            ord,
            bs: d.bs,
            be: d.be,
            vh: embedVh(renderEmbedInput('search_document:', d.chain, fm, text)),
                                       cp: CHUNKER_CP,
                                       chain: d.chain,
        };
    });

    return { chunks, carves, hadBom, fm };
}
