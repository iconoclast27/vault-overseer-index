// =============================================================================
// Vault Overseer — Chunker Corpus Generator
// src/fixtures/gen-corpus.ts
//
// Seeded, deterministic generator of hostile documents for P1–P6.
// Emits RAW BYTES ONLY — no expected structure travels with a doc.
// Ground truth (heading chains, paragraph inventories) is computed
// INDEPENDENTLY in props.ts by a naive re-parser; two implementations
// agreeing is the test (P5). If this generator declared expectations,
// agreement would be circular.
//
// Hostility catalogue (mirrors the spec's P1 generator mandate):
//   - heading trees: depth 1–4, random levels, skips in hierarchy
//   - paragraphs: 1–6 lines, Latin prose with punctuation
//   - CJK runs and emoji (4-byte astral codepoints) mid-prose
//   - tables (2–8 rows), closed and UNCLOSED code fences
//   - blank-line variety: 0, 1, 3 separators; triple newlines
//   - BOM-prepended docs; CRLF docs (BOM+CRLF combo included)
//   - frontmatter: clean, empty, degenerate (tabs, dup keys, no colons)
//   - no trailing newline; trailing blank-line runs; lone-newline tail
//   - 0-byte files; heading-only files; 7 consecutive headings (C04)
//   - over-ceiling monolith paragraphs (C01, ransom-note Latin)
//
// Determinism (corpus rule 4): mulberry32 PRNG, seed in — same docs
// out, on both machines, every run. No Date, no Math.random, no
// iteration-order dependence on Maps. String building via arrays;
// bytes encoded once at the end (UTF-8).
//
// Run standalone (smoke): prints doc stats and exits.
//   node ./src/fixtures/gen-corpus.ts [count] [seed]
// Consumed by: ./props.ts (property harness).
//
// Node note: erasable TS, .ts import extensions.
// =============================================================================

// -----------------------------------------------------------------------------
// PRNG — mulberry32. Deterministic, fast, no dependencies.
// -----------------------------------------------------------------------------

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
    let a = seed >>> 0;
    return (): number => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function rint(r: Rng, lo: number, hi: number): number {
    return lo + Math.floor(r() * (hi - lo + 1));
}

function pick<T>(r: Rng, arr: readonly T[]): T {
    return arr[Math.floor(r() * arr.length)];
}

function chance(r: Rng, p: number): boolean {
    return r() < p;
}

// -----------------------------------------------------------------------------
// Building blocks — strings assembled here, encoded to bytes by the
// caller. All content material chosen for UTF-8 stress: multi-byte
// codepoints interleave with ASCII so offset math cannot coast.
// -----------------------------------------------------------------------------

const LATIN_WORDS: readonly string[] = [
    'spine', 'shard', 'checkpoint', 'digest', 'offset', 'heal', 'fixture',
'corpus', 'probe', 'ledger', 'torn', 'buffer', 'ceiling', 'carve',
'mermaid', 'doctrine', 'verbatim', 'contiguous', 'idempotent', 'ghost',
];

const CJK_CHARS: readonly string[] = [
    '脊', '柱', '分', '片', '检', '查', '点', '摘', '要', '抵', '消',
'愈', '合', '夹', '具', '语', '料', '库', '探', '针', '账', '本',
];

/** Astral-plane emoji: 4-byte UTF-8 sequences. */
const EMOJIS: readonly string[] = ['🐱', '💜', '🔧', '📏', '🧨', '📜', '🎯'];

function latinWord(r: Rng): string {
    return pick(r, LATIN_WORDS);
}

function latinSentence(r: Rng): string {
    const n = rint(r, 3, 9);
    const words: string[] = [];
    for (let i = 0; i < n; i++) words.push(latinWord(r));
    const s = words.join(' ');
    return s.charAt(0).toUpperCase() + s.slice(1) + pick(r, ['.', '.', '.', '!', '?']);
}

function cjkRun(r: Rng): string {
    const n = rint(r, 2, 6);
    let s = '';
    for (let i = 0; i < n; i++) s += pick(r, CJK_CHARS);
    return s;
}

function emojiRun(r: Rng): string {
    const n = rint(r, 1, 3);
    let s = '';
    for (let i = 0; i < n; i++) s += pick(r, EMOJIS);
    return s;
}

/** One body text line with mixed script — ASCII, CJK, emoji, tabs. */
function hostileLine(r: Rng): string {
    const parts: string[] = [];
    if (chance(r, 0.3)) parts.push(cjkRun(r));
    parts.push(latinSentence(r));
    if (chance(r, 0.2)) parts.push(emojiRun(r));
    if (chance(r, 0.15)) parts.push('\t'); // tabs survive verbatim
    return parts.join(chance(r, 0.5) ? ' ' : '');
}

function headingLine(r: Rng, level: number): string {
    const hashes = '#'.repeat(level);
    const text = chance(r, 0.5) ? latinWord(r) : `${latinWord(r)} ${cjkRun(r)} ${latinWord(r)}`;
    // Declared simplification bait: ATX closing hashes sometimes survive.
    return chance(r, 0.1) ? `${hashes} ${text} #` : `${hashes} ${text}`;
}

function tableBlock(r: Rng): string[] {
    const cols = rint(r, 2, 4);
    const rows = rint(r, 2, 8);
    const out: string[] = [];
    const cell = (): string => chance(r, 0.3) ? cjkRun(r) : latinWord(r);
    const header = Array.from({ length: cols }, cell).join(' | ');
    out.push(`| ${header} |`);
    out.push('|' + ' --- |'.repeat(cols));
    for (let i = 0; i < rows; i++) {
        out.push(`| ${Array.from({ length: cols }, cell).join(' | ')} |`);
    }
    return out;
}

function fenceBlock(r: Rng, closed: boolean): string[] {
    const lang = pick(r, ['', 'ts', 'fish', 'mermaid']);
    const lines: string[] = ['```' + lang];
    const n = rint(r, 1, 6);
    for (let i = 0; i < n; i++) {
        if (chance(r, 0.3)) lines.push(''); // blank lines INSIDE the fence
        else lines.push(`${latinWord(r)}(${rint(r, 0, 99)}, "${latinWord(r)}");`);
    }
    if (closed) lines.push('```');
    return lines; // unclosed: fence runs to EOF (C02 shape)
}

function blankLines(r: Rng): string[] {
    const roll = r();
    if (roll < 0.5) return [''];
    if (roll < 0.8) return ['', '']; // blank-line RUN (paragraph boundary)
    return ['', '', '']; // triple — still one boundary, spec-wise
}

// -----------------------------------------------------------------------------
// Frontmatter variants — clean and hostile (C05 material)
// -----------------------------------------------------------------------------

function cleanFrontmatter(r: Rng): string[] {
    const out = ['---'];
    if (chance(r, 0.7)) out.push(`type: ${pick(r, ['note', 'session', 'ref'])}`);
    if (chance(r, 0.7)) {
        out.push(chance(r, 0.5)
        ? `tags: ${latinWord(r)}, ${latinWord(r)}`
        : `tags:\n  - ${latinWord(r)}\n  - ${latinWord(r)}`);
    }
    if (chance(r, 0.5)) out.push(`aliases: ${latinWord(r)}`);
    if (chance(r, 0.5)) out.push(`description: ${latinSentence(r)}`);
    out.push('---');
    return out;
}

function degenerateFrontmatter(r: Rng): string[] {
    const variant = rint(r, 0, 5);
    switch (variant) {
        case 0: return ['---', '---']; // empty frontmatter
        case 1: return ['---', 'not a key value line', '---']; // no colon
        case 2: return ['---', `tags: ${latinWord(r)}`, `tags: ${latinWord(r)}`, '---']; // dup
        case 3: return ['---', `\ttags:\t${latinWord(r)}`, '---']; // tabs
        case 4: return ['---', `description: value with --- inside`, '---']; // dashes in value
        case 5: return ['---', `nested: { a: [1, 2 }`, '---']; // malformed structure
        default: return ['---', '---'];
    }
}

// -----------------------------------------------------------------------------
// Document archetypes — the switch that gives the corpus its shape
// -----------------------------------------------------------------------------

function pushBody(r: Rng, lines: string[], sections: number): void {
    for (let s = 0; s < sections; s++) {
        lines.push(headingLine(r, rint(r, 1, Math.min(4, s + 2))));
        lines.push(...blankLines(r).length ? [] : []);
        const paras = rint(r, 0, 4);
        for (let p = 0; p < paras; p++) {
            // Occasionally skip the blank separator: paragraph runs
            // straight on — adjacency stress for the paragraph logic.
            if (p > 0 && chance(r, 0.25)) {
                // no separator: continue current paragraph visually
            } else if (p > 0) {
                lines.push(...blankLines(r));
            }
            const l = rint(r, 1, 6);
            for (let i = 0; i < l; i++) lines.push(hostileLine(r));
        }
        const special = r();
        if (special < 0.2) {
            lines.push(...blankLines(r));
            lines.push(...tableBlock(r));
        } else if (special < 0.4) {
            lines.push(...blankLines(r));
            lines.push(...fenceBlock(r, true));
        } else if (special < 0.48) {
            lines.push(...blankLines(r));
            lines.push(...fenceBlock(r, false)); // UNCLOSED to EOF
        }
    }
}

/** Ransom-note garbage Latin — no sentence boundaries, no spaces. C01 fuel. */
function monolith(r: Rng, targetBytes: number): string {
    let s = '';
    while (s.length < targetBytes) {
        s += pick(r, LATIN_WORDS) + pick(r, ['x', 'zz', 'q', '~']);
    }
    return s;
}

export function genDoc(r: Rng): string {
    const roll = r();
    const lines: string[] = [];

    // Archetype selection.
    if (roll < 0.04) return ''; // 0-byte file
    if (roll < 0.08) {
        // Heading-only: seven consecutive headings, no content (C04).
        for (let i = 0; i < 7; i++) lines.push(headingLine(r, rint(r, 1, 4)));
        return lines.join('\n');
    }
    if (roll < 0.14) {
        // Over-ceiling monolith: single paragraph, no sentences in
        // the middle — well past the 3072 ceiling (C01).
        lines.push(monolith(r, rint(r, 3500, 9000)));
        return lines.join('\n');
    }
    if (roll < 0.17) {
        // Lone-newline tail: content ends, single stray newline at EOF.
        pushBody(r, lines, rint(r, 1, 2));
        return lines.join('\n') + '\n';
    }
    if (roll < 0.21) {
        // Trailing blank-line RUN after the last paragraph.
        pushBody(r, lines, rint(r, 1, 3));
        return lines.join('\n') + '\n\n\n' + monolith(r, rint(r, 5, 40));
    }

    // General population: frontmatter (clean/degenerate/none) + body.
    const fmRoll = r();
    if (fmRoll < 0.45) lines.push(...cleanFrontmatter(r));
    else if (fmRoll < 0.6) lines.push(...degenerateFrontmatter(r));
    // else: no frontmatter at all

    if (fmRoll < 0.6) lines.push(...blankLines(r));
    pushBody(r, lines, rint(r, 1, 5));

    // Line endings: LF default, CRLF minority (spec: normalize nothing).
    let body = lines.join('\n');
    if (chance(r, 0.2)) {
        // CRLF pass — blank lines carry \r (reader/truth must survive).
        body = body.replace(/\n/g, '\r\n');
    }
    // Trailing newline: usually present, sometimes absent.
    if (!chance(r, 0.15) && !body.endsWith('\r\n')) body += '\n';

    // BOM prefix: minority (C03 shape with optional CRLF above).
    if (chance(r, 0.15)) body = '\uFEFF' + body;

    return body;
}

// -----------------------------------------------------------------------------
// Corpus API
// -----------------------------------------------------------------------------

/**
 * Generate `count` documents from a base seed. Doc i uses the stream
 * seeded with (baseSeed ^ i) — doc i's bytes depend ONLY on i and the
 * base seed, never on iteration over previous docs. Reproducible
 * per-doc: genCorpus(1, baseSeed ^ 7)[0] === the 8th doc, always.
 */
export function genCorpus(count: number, baseSeed: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
        const r = mulberry32((baseSeed ^ i) >>> 0);
        out.push(Buffer.from(genDoc(r), 'utf-8'));
    }
    return out;
}

// -----------------------------------------------------------------------------
// Standalone smoke: distribution sanity, no property assertions.
// -----------------------------------------------------------------------------

if (import.meta.main) {
    const args = process.argv.slice(2);
    const count = Number(args[0] ?? 500);
    const seed = Number(args[1] ?? 20261022);
    const docs = genCorpus(count, seed);
    let empty = 0, bom = 0, crlf = 0, huge = 0, total = 0;
    for (const d of docs) {
        total += d.length;
        if (d.length === 0) empty++;
        if (d.length >= 3 && d[0] === 0xef && d[1] === 0xbb && d[2] === 0xbf) bom++;
        for (let i = 0; i < Math.min(d.length - 1, 64); i++) {
            if (d[i] === 0x0d && d[i + 1] === 0x0a) { crlf++; break; }
        }
        if (d.length > 3072) huge++;
    }
    console.log(`gen-corpus smoke: ${count} docs from seed ${seed}`);
    console.log(`  total bytes: ${total}, avg: ${Math.round(total / count)}`);
    console.log(`  empty: ${empty}, BOM: ${bom}, CRLF: ${crlf}, >ceiling: ${huge}`);
    console.log(`  determinism: ${
        JSON.stringify(genCorpus(1, seed ^ 3)[0]) === JSON.stringify(docs[3])
        ? 'PER-DOC SEEDING HOLDS' : 'BROKEN — per-doc seeding violated'}`);
}
