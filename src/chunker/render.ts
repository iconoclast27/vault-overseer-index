// =============================================================================
// Vault Overseer — Render Contract (shared, single implementation)
// src/chunker/render.ts
//
// The ONE place that builds the string sent to the embedder. The chunker
// and the embed path both import from here — two implementations would
// be two drift opportunities (Chunker Spec Step 6, VC's lesson
// generalized). Also owns the canonical fm_context serialization and
// its forgiving parser, so render and parse live as one contract pair.
//
// SERIALIZATION CONTRACT (bytes are law, forever):
//   embed_input := PREFIX CHAIN? FM? CHUNK_TEXT
//     PREFIX     — 'search_document:' | 'search_query:' (R3, locked)
//     CHAIN      — each heading text followed by '\n' (nothing if the
//                  chain is empty). Elements are used VERBATIM — the
//                  producer (chunker) trims heading text; the renderer
//                  never mutates its inputs.
//     FM         — serializeFmContext(fm) + '\n' when the canonical form
//                  is non-null; omitted entirely for null/empty fm.
//     CHUNK_TEXT — chunk bytes decoded, as-is.
//
//   EQUIVALENCE GUARANTEE: (prefix, [], null, text) renders EXACTLY as
//   the stub's old three-part form. Every cp:0 vh survives this module
//   replacing the stub's private copy, byte-identical. Fixture rerun
//   confirms — probable until proven.
//
// fm_context canonical form: compact JSON, keys alphabetical (aliases,
// description, tags, type), strings trimmed, arrays element-trimmed.
// NO coercion: 'tags: foo' (scalar) and 'tags: [foo]' (list) are
// different bytes and therefore different vh — the bytes are the
// contract, not YAML intent.
//
// Parser (C05 posture): degenerate by design. Malformed lines skipped,
// duplicate keys first-wins, unknown keys ignored, nested structures
// beyond flat values and dash-lists skipped. NEVER throws.
// Known simplification, declared: commas inside quoted bracket-list
// elements ('[a, "b,c"]') are not respected — the naive split is
// deterministic, and determinism outranks YAML fidelity here.
//
// Node note: node:crypto, erasable TS, .ts import extensions.
// =============================================================================

import { createHash } from 'node:crypto';

export type TaskPrefix = 'search_document:' | 'search_query:';

/** Selected frontmatter keys — Spec Step 1. Unknown keys ignored. */
export interface FmContext {
    aliases?: string | string[];
    description?: string;
    tags?: string | string[];
    type?: string;
}

/** SHA-256 → 16 hex chars, matching schema's content-addressing width. */
export function sha16(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** content_sha of a note: SHA-256 of full file bytes, 16 hex. */
export function contentSha(fileBytes: Uint8Array): string {
    return sha16(fileBytes);
}

// -----------------------------------------------------------------------------
// Canonical serialization
// -----------------------------------------------------------------------------

function canonScalarOrList(v: string | string[] | undefined): string | string[] | null {
    if (v === undefined) return null;
    if (typeof v === 'string') {
        const t = v.trim();
        return t === '' ? null : t;
    }
    const items = v.map(s => s.trim()).filter(s => s !== '');
    return items.length === 0 ? null : items;
}

/**
 * Canonical fm_context form, or null when there is nothing to say.
 * Keys are inserted in alphabetical order; JSON.stringify preserves
 * insertion order, so the output key order IS the sort. Injective —
 * no delimiter games for P6 to police.
 */
export function serializeFmContext(fm: FmContext | null): string | null {
    if (fm === null) return null;
    const out: Record<string, string | string[]> = {};
    const aliases = canonScalarOrList(fm.aliases);
    if (aliases !== null) out.aliases = aliases;
    if (typeof fm.description === 'string') {
        const t = fm.description.trim();
        if (t !== '') out.description = t;
    }
    const tags = canonScalarOrList(fm.tags);
    if (tags !== null) out.tags = tags;
    if (typeof fm.type === 'string') {
        const t = fm.type.trim();
        if (t !== '') out.type = t;
    }
    if (Object.keys(out).length === 0) return null;
    return JSON.stringify(out);
}

/**
 * The single embed-input builder. Pure: same inputs ⇒ same string,
 * always, on both machines (P3/F04 depend on this).
 */
export function renderEmbedInput(
    taskPrefix: TaskPrefix,
    headingChain: readonly string[],
    fmContext: FmContext | null,
    chunkText: string,
): string {
    let out = taskPrefix;
    for (const heading of headingChain) out += heading + '\n';
    const fm = serializeFmContext(fmContext);
    if (fm !== null) out += fm + '\n';
    return out + chunkText;
}

/** vh of a rendered embed input. */
export function embedVh(embedInput: string): string {
    return sha16(Buffer.from(embedInput, 'utf-8'));
}

// -----------------------------------------------------------------------------
// Forgiving frontmatter parser (text between the '---' delimiters)
// -----------------------------------------------------------------------------

const SELECTED_KEYS = new Set<string>(['aliases', 'description', 'tags', 'type']);

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*:/;
const DASH_ITEM_RE = /^\s+-\s?(.*)$/;

function stripQuotes(s: string): string {
    if (s.length >= 2 &&
        ((s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'")))) {
        return s.slice(1, -1).trim();
        }
        return s;
}

function assign(fm: FmContext, key: string, value: string | string[]): void {
    if (key === 'aliases') fm.aliases = value;
    else if (key === 'tags') fm.tags = value;
    else if (key === 'description') fm.description = value;
    else if (key === 'type') fm.type = value;
}

function parseInlineValue(rest: string): string | string[] {
    if (rest.startsWith('[') && rest.endsWith(']')) {
        const inner = rest.slice(1, -1).trim();
        if (inner === '') return [];
        return inner.split(',').map(s => stripQuotes(s.trim())).filter(s => s !== '');
    }
    return stripQuotes(rest);
}

/**
 * Parse a raw frontmatter block into an FmContext. Never throws (C05);
 * degeneracy degrades to fewer keys, down to an empty object — which
 * serializeFmContext maps to null (no fm in the embed input). Dash-list
 * continuations are consumed for every key-shaped line, selected or
 * not, so skipped keys can't leak their items into the next parse.
 */
export function parseFmContext(blockText: string): FmContext {
    const fm: FmContext = {};
    const lines = blockText.split('\n').map(l => l.replace(/\r$/, ''));
    const seen = new Set<string>();
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!KEY_RE.test(line)) { i++; continue; }
        const colon = line.indexOf(':');
        const key = line.slice(0, colon);
        const rest = line.slice(colon + 1).trim();
        const isDashListHead = rest === '';
        const items: string[] = [];
        let j = i + 1;
        while (j < lines.length) {
            const dm = DASH_ITEM_RE.exec(lines[j]);
            if (dm === null) break;
            items.push(stripQuotes(dm[1].trim()));
            j++;
        }
        if (seen.has(key) || !SELECTED_KEYS.has(key)) { i = j; continue; }
        seen.add(key);
        if (isDashListHead) {
            if (items.length > 0) assign(fm, key, items);
        } else {
            assign(fm, key, parseInlineValue(rest));
        }
        i = j;
    }
    return fm;
}
