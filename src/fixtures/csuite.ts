// =============================================================================
// Vault Overseer — Chunker Slow Suite (C01–C06)
// src/fixtures/csuite.ts
//
// Hand-crafted hostile fixtures for Chunker Spec v0.1 — the lane the
// property corpus cannot reach (finding B): deterministic adversarial
// documents with EXPECTED geometry, pinned by arithmetic independent
// of the chunker. The corpus proves laws over random populations;
// this suite proves boundaries on named, reproducible monsters.
//
// INCREMENT 4 of 4 (2026-10-22): C06 — the LOG-LANE fixture. The
// bridge module (src/indexer/emit.ts) converts the chunker's output
// into event-log vocabulary; C06 drives it through a RecordingSink
// (structural IndexLogSink, no EventLog, no adapters, no I/O) and
// asserts what actually crossed the bridge.
//
// BYTE DISCIPLINE (learned the hard way, C02(b) first contact):
//   Every document below is assembled from NAMED Buffers, and every
//   expected offset is derived from .length of those buffers. No
//   magic numbers, no '+2' guesses about separator widths. Offsets
//   come from arithmetic or they come from nowhere.
//
// ASYNC DISCIPLINE (learned the hard way, C06 first contact — the
//   run of 2026-10-22 17:04): (1) the suite's tail invoked main()
//   TWICE, doubling every line and cross-contaminating the per-fixture
//   failure tallies — the [C05] RED verdict in that log was a lie told
//   by run two's C06; (2) C06 assigned emitChunkResult's Promise
//   without awaiting it, so assertions raced the emissions. The FAILs
//   were real; the attributions were not. Rules now: ONE main call;
//   every await is spelled out; no IIFE scaffolding.
//
// C01 — Over-ceiling monolith: byte-carve into ⌈len/CEILING⌉ pieces,
//   N−1 carves, every carve.be === the paragraph end (CarveNote
//   shape: be is the ENCLOSING range end, not the piece end).
//
// C02 — Fence shapes: (a) closed/under-target merges; (b) unclosed
//   runs to EOF atomic; (c) ADJACENT fence over an OVER-CEILING text
//   paragraph — the finding-B case and the ONLY test of the cp: 2
//   fix. Under cp: 1 the fence was absorbed and carved THROUGH; the
//   fixture's span assertions red on that geometry.
//
// C03 — BOM + CRLF + leading heading: offsets byte-accounted, never
//   decoded-string-index math.
//
// C04 — Heading with no content (ruling 2): DECLARED BEHAVIOUR —
//   contentless notes yield ZERO chunks. Variants: pure headings /
//   headings + blanks / trailing blank run / empty file / fm-only
//   (parsed but riderless).
//
// C05 — Frontmatter degeneracies (ruling 3): per-variant expected fm
//   table. v2 first-wins and v4 '---'-inside-value are features;
//   v3 tab-key null is a declared simplification; v-clean control
//   proves the nulls are degradation, not fixture failure.
//
// C06 — Rename invariant + bridge emission (log lane, ruling 4 + 6):
//   (a) BRIDGE PARITY: C01's monolith through emitChunkResult —
//       summary counts, chunk.indexed payloads byte-identical to the
//       chunker's spans, carve details naming paragraph_end vs the
//       piece span separately (ruling 5).
//   (b) RENAME INVARIANT: same bytes at two paths — identical vh
//       sets, each vh present under BOTH paths. Renames leave vh
//       untouched; only path differs.
//   (c) REFUSED-EMPTY GUARD: a crafted empty-span chunk produces
//       log.integrity, never a poisoned chunk.indexed.
//   (d) ZERO-CHUNK SILENCE: contentless note crosses the bridge
//       emitting nothing — silence is correct, not a log gap.
//
// Run:  node ./src/fixtures/csuite.ts
// Node note: erasable TS, .ts import extensions.
// =============================================================================

import {
      chunkNote, CHUNKER_CP, CEILING_BYTES, TARGET_BYTES, type Chunk,
} from '../chunker/chunker.ts';
import {
      embedVh, renderEmbedInput, serializeFmContext, type FmContext,
} from '../chunker/render.ts';
import {
      emitChunkIndexed, emitChunkResult, type IndexLogSink,
} from '../indexer/emit.ts';

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

let checks = 0;
let failures = 0;

function check(name: string, ok: boolean, detail?: string): boolean {
      checks++;
      if (ok) return true;
      failures++;
      console.log(`[FAIL] ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
      return true;
}

/** P1 in miniature: the slice decodes clean and re-renders to the same vh. */
function vhRepro(label: string, doc: Uint8Array, c: Chunk, fm: FmContext | null): void {
      const text = Buffer.from(doc.subarray(c.bs, c.be)).toString('utf-8');
      check(`${label} UTF-8 clean`, !text.includes('\uFFFD'));
      check(`${label} vh repro`,
            embedVh(renderEmbedInput('search_document:', c.chain, fm, text)) === c.vh);
}

/** Constants pinned by literal — a constant that polices itself proves nothing. */
function pinnedConstants(id: string): void {
      check(`${id} cp pinned at 2`, CHUNKER_CP === 2, `got ${CHUNKER_CP}`);
      check(`${id} ceiling pinned at 3072`, CEILING_BYTES === 3072, `got ${CEILING_BYTES}`);
      check(`${id} target pinned at 2048`, TARGET_BYTES === 2048, `got ${TARGET_BYTES}`);
}

/**
 * Run chunkNote under a throw-guard: a throw becomes a named FAIL,
 * never a crash that hides which variant detonated. The "never throws"
 * clause of C04/C05 is only testable if throwing is survivable.
 */
function quietChunk(label: string, doc: Uint8Array):
{ ok: boolean; res: ReturnType<typeof chunkNote> | null } {
      try {
            return { ok: true, res: chunkNote(doc) };
      } catch (err) {
            check(`${label} never throws`, false, String(err));
            return { ok: false, res: null };
      }
}

// -----------------------------------------------------------------------------
// RecordingSink — the log lane's phantom limb
// -----------------------------------------------------------------------------

/** One captured event crossing the bridge. */
interface Recorded {
      readonly type: string;
      readonly payload: Record<string, unknown>;
      readonly detail?: string; // log.integrity only
}

/**
 * Structural IndexLogSink: records every event, resolves immediately.
 * No EventLog, no adapters, no temp dirs, no flush timing. Tests the
 * BRIDGE, not the log — the log has its own harness.
 *
 * appendEvent records synchronously INSIDE the resolved microtask, so
 * once an awaited bridge call returns, everything it pushed is visible.
 */
class RecordingSink implements IndexLogSink {
      readonly events: Recorded[] = [];

      async appendEvent(
            _actor: 'user' | 'plugin' | 'sync',
            type: string,
            payload: unknown,
      ): Promise<void> {
            const p = payload as Record<string, unknown>;
            const rec: Recorded = { type, payload: p };
            if (type === 'log.integrity') rec.detail = p.detail as string | undefined;
            this.events.push(rec);
      }

      async reportIntegrity(detail: string): Promise<void> {
            this.events.push({
                  type: 'log.integrity', payload: { detail }, detail,
            });
      }

      of(type: string): Recorded[] {
            return this.events.filter(e => e.type === type);
      }
}

// -----------------------------------------------------------------------------
// C01 — Over-ceiling monolith carve disclosures
// -----------------------------------------------------------------------------

function c01Monolith(): void {
      pinnedConstants('C01');

      // Ransom-note garbage Latin: no sentence terminators, no whitespace.
      // 29 bytes per iteration, run past 3× the ceiling.
      let body = '';
      while (body.length < CEILING_BYTES * 3) body += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' + 'XYZ';
      const doc = Buffer.from(body, 'utf-8');

      const run = quietChunk('C01', doc);
      if (!run.ok || run.res === null) return;
      const res = run.res;

      check('C01 hadBom false', res.hadBom === false);
      check('C01 fm null', res.fm === null);
      check('C01 carves non-zero', res.carves.length > 0, `${res.carves.length}`);

      // N pieces ⇒ N−1 carves (the final remainder emits no disclosure).
      const expectedCarves = Math.max(0, res.chunks.length - 1);
      check(`C01 carve count == pieces−1 (${expectedCarves})`,
            res.carves.length === expectedCarves,
            `got ${res.carves.length}`);

      // Piece count from arithmetic: ⌈len / CEILING⌉.
      const expectedPieces = Math.ceil(doc.length / CEILING_BYTES);
      check(`C01 piece count == ⌈len/CEILING⌉ (${expectedPieces})`,
            res.chunks.length === expectedPieces,
            `got ${res.chunks.length}`);

      // Whole file is one paragraph ⇒ every carve's be is the file end.
      for (const car of res.carves) {
            check('C01 carve be === paragraph end', car.be === doc.length,
                  `got ${car.be} vs ${doc.length}`);
            check('C01 carve reason', car.reason === 'over-ceiling-byte-carved', car.reason);
      }

      // Spans tile [0, doc.length) exactly — no gaps, no overlaps.
      let cursor = 0;
      for (const c of res.chunks) {
            check(`C01 chunk ${c.ord} contiguous at ${cursor}`, c.bs === cursor,
                  `bs=${c.bs} expected ${cursor}`);
            check(`C01 chunk ${c.ord} ≤ CEILING`, c.be - c.bs <= CEILING_BYTES,
                  `len=${c.be - c.bs}`);
            check(`C01 chunk ${c.ord} non-empty`, c.be > c.bs);
            check(`C01 chunk ${c.ord} cp=2`, c.cp === 2, `got ${c.cp}`);
            vhRepro(`C01 chunk ${c.ord}`, doc, c, res.fm);
            cursor = c.be;
      }
      check('C01 pieces cover whole file', cursor === doc.length, `cursor=${cursor}`);

      const again = chunkNote(doc);
      check('C01 deterministic rerun', JSON.stringify(again) === JSON.stringify(res));

      console.log(`C01: ${res.chunks.length} pieces, ${res.carves.length} carves, ${doc.length} bytes`);
}

// -----------------------------------------------------------------------------
// C02 — Fence shapes
// -----------------------------------------------------------------------------

function c02Fences(): void {
      pinnedConstants('C02');

      // ---- C02(a): closed fence, under target → merges into one chunk ----
      const aHead   = Buffer.from('# Section\n', 'utf-8');
      const aBlank1 = Buffer.from('\n', 'utf-8');
      const aText1  = Buffer.from('Some text line one.\n', 'utf-8');
      const aBlank2 = Buffer.from('\n', 'utf-8');
      const aFence  = Buffer.from('```ts\nconsole.log("hello");\n```\n', 'utf-8');
      const aBlank3 = Buffer.from('\n', 'utf-8');
      const aText2  = Buffer.from('More text line two.', 'utf-8');
      const aDoc = Buffer.concat([aHead, aBlank1, aText1, aBlank2, aFence, aBlank3, aText2]);
      const aContentStart = aHead.length + aBlank1.length;

      const aRes = chunkNote(aDoc);
      check('C02(a) exactly one chunk', aRes.chunks.length === 1, `${aRes.chunks.length}`);
      check('C02(a) carves empty', aRes.carves.length === 0, `${aRes.carves.length}`);
      if (aRes.chunks.length === 1) {
            const c = aRes.chunks[0];
            check('C02(a) span is [contentStart, EOF)',
                  c.bs === aContentStart && c.be === aDoc.length,
                  `got [${c.bs},${c.be}) want [${aContentStart},${aDoc.length})`);
                  check('C02(a) chain', JSON.stringify(c.chain) === JSON.stringify(['Section']),
                        JSON.stringify(c.chain));
                  const text = Buffer.from(aDoc.subarray(c.bs, c.be)).toString('utf-8');
                  check('C02(a) merged text holds fence', text.includes('```ts'));
                  check('C02(a) merged text holds tail', text.includes('More text line two.'));
                  vhRepro('C02(a)', aDoc, c, aRes.fm);
      }

      // ---- C02(b): unclosed fence → atomic paragraph to EOF ----
      const bHead   = Buffer.from('# Heading\n', 'utf-8');
      const bBlank1 = Buffer.from('\n', 'utf-8');
      const bText   = Buffer.from('Text before fence.\n', 'utf-8');
      const bBlank2 = Buffer.from('\n', 'utf-8');
      const bFence  = Buffer.from('```python\ndef foo(): pass', 'utf-8'); // never closed
      const bDoc = Buffer.concat([bHead, bBlank1, bText, bBlank2, bFence]);
      const bContentStart = bHead.length + bBlank1.length;

      const bRes = chunkNote(bDoc);
      check('C02(b) exactly one chunk', bRes.chunks.length === 1, `${bRes.chunks.length}`);
      check('C02(b) carves empty', bRes.carves.length === 0, `${bRes.carves.length}`);
      if (bRes.chunks.length === 1) {
            const c = bRes.chunks[0];
            check('C02(b) bs >= content start (heading declined)',
                  c.bs >= bContentStart,
                  `bs=${c.bs} contentStart=${bContentStart}`);
            check('C02(b) be === EOF', c.be === bDoc.length,
                  `be=${c.be} len=${bDoc.length}`);
            check('C02(b) chain', JSON.stringify(c.chain) === JSON.stringify(['Heading']),
                  JSON.stringify(c.chain));
            const text = Buffer.from(bDoc.subarray(c.bs, c.be)).toString('utf-8');
            check('C02(b) holds unclosed fence', text.includes('```python'));
            check('C02(b) holds fence body', text.includes('def foo(): pass'));
            vhRepro('C02(b)', bDoc, c, bRes.fm);
      }
      // No chunk may claim heading bytes (P2 hard-decline zone).
      for (const c of bRes.chunks) {
            check(`C02(b) chunk ${c.ord} claims no heading bytes`, c.bs >= bContentStart,
                  `bs=${c.bs} < ${bContentStart}`);
      }

      // ---- C02(c): ADJACENT fence over an OVER-CEILING text paragraph ----
      // The finding-B monster. cp: 1 absorbed the fence and carved through
      // it; cp: 2 keeps the fence intact as its own chunk.
      const cHead   = Buffer.from('# Title\r\n', 'utf-8');
      const cBlank  = Buffer.from('\r\n', 'utf-8');
      const cAlpha  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'; // 26 ASCII bytes
      const cText   = Buffer.from(cAlpha.repeat(150) + '\r\n', 'utf-8'); // 3902 bytes > CEILING
      const cFence  = Buffer.from('```javascript\r\nconsole.log("adjacent");\r\n```\r\n', 'utf-8');
      const cDoc = Buffer.concat([cHead, cBlank, cText, cFence]);
      const cContentStart = cHead.length + cBlank.length;
      const cFenceStart   = cContentStart + cText.length;

      const cRes = chunkNote(cDoc);

      // Arithmetic: text para carves into ⌈3902/3072⌉ = 2 pieces (1 carve),
      // then the fence is its own chunk. 3 chunks total.
      const expectedTextPieces = Math.ceil(cText.length / CEILING_BYTES);
      check(`C02(c) chunk count == textPieces + 1 (${expectedTextPieces + 1})`,
            cRes.chunks.length === expectedTextPieces + 1,
            `got ${cRes.chunks.length}`);
      check('C02(c) exactly one carve', cRes.carves.length === 1, `${cRes.carves.length}`);

      // THE FINDING-B ASSERTION: the fence span [cFenceStart, EOF) is
      // entirely inside exactly one chunk, and no chunk boundary falls
      // strictly within it. Under cp: 1 this reds.
      let fenceHolders = 0;
      let boundaryInsideFence = 0;
      for (const c of cRes.chunks) {
            if (c.bs <= cFenceStart && cFenceStart < c.be) fenceHolders++;
            if (c.bs > cFenceStart && c.bs < cDoc.length) boundaryInsideFence++;
      }
      check('C02(c) fence held by exactly one chunk', fenceHolders === 1, `${fenceHolders}`);
      check('C02(c) no boundary inside fence span', boundaryInsideFence === 0,
            `${boundaryInsideFence}`);

      // The final chunk IS the fence, whole and intact.
      const last = cRes.chunks[cRes.chunks.length - 1];
      check('C02(c) last chunk is the fence span',
            last.bs === cFenceStart && last.be === cDoc.length,
            `got [${last.bs},${last.be}) want [${cFenceStart},${cDoc.length})`);
            const lastText = Buffer.from(cDoc.subarray(last.bs, last.be)).toString('utf-8');
            check('C02(c) last chunk starts with fence opener',
                  lastText.startsWith('```javascript'), JSON.stringify(lastText.slice(0, 20)));

            // Text pieces tile [contentStart, fenceStart) exactly, no carve bleed.
            let cursor = cContentStart;
            for (let i = 0; i < cRes.chunks.length - 1; i++) {
                  const c = cRes.chunks[i];
                  check(`C02(c) text piece ${i} contiguous at ${cursor}`, c.bs === cursor,
                        `bs=${c.bs} expected ${cursor}`);
                  check(`C02(c) text piece ${i} ≤ CEILING`, c.be - c.bs <= CEILING_BYTES,
                        `len=${c.be - c.bs}`);
                  cursor = c.be;
            }
            check('C02(c) text pieces end at fence start', cursor === cFenceStart,
                  `cursor=${cursor} fenceStart=${cFenceStart}`);

            // Carve disclosure points at the enclosing paragraph end == fence start.
            check('C02(c) carve be === text paragraph end',
                  cRes.carves[0]?.be === cFenceStart,
                  `got ${cRes.carves[0]?.be} vs ${cFenceStart}`);

            // Everything: bounded, aligned, chained, reproducible.
            for (const c of cRes.chunks) {
                  check(`C02(c) chunk ${c.ord} non-empty`, c.be > c.bs, `[${c.bs},${c.be})`);
                  check(`C02(c) chunk ${c.ord} ≤ CEILING`, c.be - c.bs <= CEILING_BYTES,
                        `len=${c.be - c.bs}`);
                  check(`C02(c) chunk ${c.ord} chain`, JSON.stringify(c.chain) === JSON.stringify(['Title']),
                        JSON.stringify(c.chain));
                  vhRepro(`C02(c) chunk ${c.ord}`, cDoc, c, cRes.fm);
            }

            const cAgain = chunkNote(cDoc);
            check('C02(c) deterministic rerun', JSON.stringify(cAgain) === JSON.stringify(cRes));

            console.log(`C02: (a) ${aRes.chunks.length} chunk, (b) ${bRes.chunks.length} chunk, ` +
            `(c) ${cRes.chunks.length} chunks / ${cRes.carves.length} carve`);
}

// -----------------------------------------------------------------------------
// C03 — BOM + CRLF + leading heading, byte-accounted offsets
// -----------------------------------------------------------------------------

function c03(): void {
      pinnedConstants('C03');

      // Segments are Buffers from birth; every offset below derives from
      // the .length of those byte arrays. Multi-byte material (BOM, CJK,
      // 4-byte emoji) sits AHEAD of the ASCII paragraphs, so string-index
      // math cannot coast — it is wrong by construction if attempted.
      const bom     = Buffer.from([0xef, 0xbb, 0xbf]);
      const heading = Buffer.from('# Title 脊柱\r\n', 'utf-8');
      const sepA    = Buffer.from('\r\n', 'utf-8');
      const para1   = Buffer.from('Paragraph one with CJK 分片 and emoji 🐱 mixed in.\r\n', 'utf-8');
      const sepB    = Buffer.from('\r\n', 'utf-8');
      const para2   = Buffer.from('Paragraph two: ASCII only, ends with punctuation!\r\n', 'utf-8');
      const sepC    = Buffer.from('\r\n', 'utf-8');
      const sub     = Buffer.from('## Sub 摘要\r\n', 'utf-8');
      const sepD    = Buffer.from('\r\n', 'utf-8');
      const para3   = Buffer.from('Paragraph three under the subheading.\r\n', 'utf-8');

      const doc = Buffer.concat([bom, heading, sepA, para1, sepB, para2, sepC, sub, sepD, para3]);

      // Expected geometry by byte arithmetic — the oracle:
      //   BOM + heading line are DECLINED (P2 rules);
      //   para1 + para2 merge under target into one chunk;
      //   the '## Sub' heading closes it; para3 is its own chunk.
      const headEnd = bom.length + heading.length;
      const p1s     = headEnd + sepA.length;
      const p2s     = p1s + para1.length + sepB.length;
      const p2e     = p2s + para2.length;
      const p3s     = p2e + sepC.length + sub.length + sepD.length;
      const p3e     = p3s + para3.length; // == doc.length

      const res = chunkNote(doc);

      check('C03 BOM detected', res.hadBom === true);
      check('C03 carves empty', res.carves.length === 0, `${res.carves.length} carves`);

      check('C03 chunk count === 2', res.chunks.length === 2, `got ${res.chunks.length}`);
      if (res.chunks.length === 2) {
            const [c0, c1] = res.chunks;

            check('C03 chunk 0 span [p1s, p2e)',
                  c0.bs === p1s && c0.be === p2e,
                  `got [${c0.bs},${c0.be}) want [${p1s},${p2e})`);
                  check('C03 chunk 1 span [p3s, p3e)',
                        c1.bs === p3s && c1.be === p3e,
                        `got [${c1.bs},${c1.be}) want [${p3s},${p3e})`);

                        // Byte-accounting proof: the span's first byte decodes to 'P'.
                        // String-index math after 脊柱/分片/🐱 lands somewhere else.
                        check('C03 chunk 1 starts on P',
                              Buffer.from(doc.subarray(c1.bs, c1.bs + 1)).toString('utf-8') === 'P',
                              `first byte at ${c1.bs} is not 'P'`);

                        // CRLF faithfulness: the CR is inside the span, not trimmed.
                        check('C03 chunk 1 ends with CRLF',
                              Buffer.from(doc.subarray(c1.be - 2, c1.be)).toString('utf-8') === '\r\n');

                        // Heading lines declined; their text rides the chain instead.
                        check('C03 chunk 0 chain',
                              JSON.stringify(c0.chain) === JSON.stringify(['Title 脊柱']),
                              JSON.stringify(c0.chain));
                        check('C03 chunk 1 chain',
                              JSON.stringify(c1.chain) === JSON.stringify(['Title 脊柱', 'Sub 摘要']),
                              JSON.stringify(c1.chain));
      }

      // No chunk claims BOM or heading bytes (P2 hard-decline zone).
      for (const c of res.chunks) {
            check(`C03 no claim before headEnd (ord ${c.ord})`, c.bs >= headEnd,
                  `bs=${c.bs} < ${headEnd}`);
      }

      for (const c of res.chunks) {
            check(`C03 cp stamped 2 (ord ${c.ord})`, c.cp === 2, `got ${c.cp}`);
            check(`C03 non-empty dense ord (ord ${c.ord})`, c.be > c.bs && c.ord >= 0);
            vhRepro(`C03 chunk ${c.ord}`, doc, c, res.fm);
      }

      const again = chunkNote(doc);
      check('C03 deterministic rerun', JSON.stringify(again) === JSON.stringify(res));
}

// -----------------------------------------------------------------------------
// C04 — Heading with no content: zero chunks, DECLARED (ruling 2)
// -----------------------------------------------------------------------------

/** Assert the full zero-chunk contract on a contentless variant. */
function c04AssertZero(label: string, doc: Uint8Array): void {
      const run = quietChunk(`C04 ${label}`, doc);
      if (!run.ok || run.res === null) return;
      const res = run.res;

      check(`C04 ${label}: zero chunks`, res.chunks.length === 0,
            `${res.chunks.length}`);
      check(`C04 ${label}: zero carves`, res.carves.length === 0,
            `${res.carves.length}`);

      // Zero-length chunks never emitted; ord density holds vacuously over [].
      for (const c of res.chunks) {
            check(`C04 ${label}: no zero-length chunk`, c.be > c.bs);
      }

      const again = chunkNote(doc);
      check(`C04 ${label}: deterministic rerun`, JSON.stringify(again) === JSON.stringify(res));
}

function c04HeadingOnly(): void {
      pinnedConstants('C04');

      // Variant 1: seven consecutive headings, no separators (the C04 shape).
      const v1Lines = [
            '# One', '## Two', '### Three', '# Four', '## Five', '### Six', '# Seven',
      ];
      c04AssertZero('pure-headings', Buffer.from(v1Lines.join('\n'), 'utf-8'));

      // Variant 2: headings with blank lines between them — separators
      // do not rescue contentlessness.
      const v2Lines = ['# One', '', '## Two', '', '### Three'];
      c04AssertZero('headings-plus-blanks', Buffer.from(v2Lines.join('\n'), 'utf-8'));

      // Variant 3: content, then headings, then trailing blank run — the
      // trailing void contributes nothing; the leading paragraph DOES chunk.
      const v3Head  = Buffer.from('# Real\n', 'utf-8');
      const v3Blank = Buffer.from('\n', 'utf-8');
      const v3Body  = Buffer.from('Actual content here.\n', 'utf-8');
      const v3Void  = Buffer.from('\n\n\n# Skeleton\n\n\n', 'utf-8');
      const v3Doc   = Buffer.concat([v3Head, v3Blank, v3Body, v3Void]);
      const v3Run   = quietChunk('C04 trailing-blanks', v3Doc);
      if (v3Run.ok && v3Run.res !== null) {
            const res = v3Run.res;
            // Exactly one chunk: the paragraph. The trailing heading+blanks
            // are declined; no second chunk for the void.
            check('C04 trailing-blanks: exactly one chunk', res.chunks.length === 1,
                  `${res.chunks.length}`);
            if (res.chunks.length === 1) {
                  const c = res.chunks[0];
                  const bodyStart = v3Head.length + v3Blank.length;
                  const bodyEnd   = bodyStart + v3Body.length;
                  check('C04 trailing-blanks: span is the paragraph',
                        c.bs === bodyStart && c.be === bodyEnd,
                        `got [${c.bs},${c.be}) want [${bodyStart},${bodyEnd})`);
                        check('C04 trailing-blanks: chain',
                              JSON.stringify(c.chain) === JSON.stringify(['Real']),
                              JSON.stringify(c.chain));
                        vhRepro('C04 trailing-blanks', v3Doc, c, res.fm);
            }
      }

      // Variant 4: empty file (0 bytes).
      c04AssertZero('empty-file', new Uint8Array(0));

      // Variant 5: frontmatter-only — fm parses (down to null: no selected
      // keys), body is empty, zero chunks. The fm_context is stamped
      // nowhere: no chunks, no rider.
      const v5Fm   = Buffer.from('---\ntype: note\n---\n', 'utf-8');
      c04AssertZero('frontmatter-only', v5Fm);
      const v5Rerun = chunkNote(v5Fm);
      check('C04 frontmatter-only: fm parsed but riderless', v5Rerun.fm !== null);

      console.log('C04: contentless notes are file-known but index-invisible (DECLARED)');
}

// -----------------------------------------------------------------------------
// C05 — Frontmatter degeneracies: per-variant expected fm (ruling 3)
// -----------------------------------------------------------------------------

/**
 * One C05 variant: fm block bytes + a body paragraph. Asserts:
 * never throws, expected canonical fm (null or exact string), exactly
 * one chunk, span byte-accounted past the fm block, empty chain, fm
 * stamped into vh, deterministic.
 */
function c05Variant(
      label: string,
      fmBlock: Buffer,
      expectedCanonicalFm: string | null,
): void {
      const fmSep  = Buffer.from('\n', 'utf-8');
      const body   = Buffer.from('Body paragraph one.', 'utf-8');
      const doc    = Buffer.concat([fmBlock, fmSep, body]);
      const bodyStart = fmBlock.length + fmSep.length;

      const run = quietChunk(`C05 ${label}`, doc);
      if (!run.ok || run.res === null) return;
      const res = run.res;

      // The per-variant expected fm — THE corrected criterion. The spec's
      // blanket "degrades to null" is wrong for v2 and v4; the table is law.
      const gotCanonical = serializeFmContext(res.fm);
      check(`C05 ${label}: fm == expected`, gotCanonical === expectedCanonicalFm,
            `got ${gotCanonical} want ${expectedCanonicalFm}`);

      // Chunking proceeds regardless: one chunk, body-only span.
      check(`C05 ${label}: exactly one chunk`, res.chunks.length === 1,
            `${res.chunks.length}`);
      if (res.chunks.length === 1) {
            const c = res.chunks[0];
            check(`C05 ${label}: span is the body paragraph`,
                  c.bs === bodyStart && c.be === doc.length,
                  `got [${c.bs},${c.be}) want [${bodyStart},${doc.length})`);
                  check(`C05 ${label}: chain empty`, c.chain.length === 0,
                        JSON.stringify(c.chain));
                  // fm stamps into vh — vhRepro re-renders with res.fm, so a chunk
                  // whose vh ignored the parsed fm would fail here.
                  vhRepro(`C05 ${label}`, doc, c, res.fm);
      }

      const again = chunkNote(doc);
      check(`C05 ${label}: deterministic rerun`, JSON.stringify(again) === JSON.stringify(res));
}

function c05FrontmatterDegeneracies(): void {
      pinnedConstants('C05');

      // v0: empty frontmatter.
      c05Variant('v0-empty', Buffer.from('---\n---\n', 'utf-8'), null);

      // v1: no colon — line is not key-shaped, skipped wholesale.
      c05Variant('v1-no-colon', Buffer.from('---\nnot a key value line\n---\n', 'utf-8'), null);

      // v2: duplicate tags — FIRST WINS (declared in render.ts). The
      // spec's "degrades to null" is wrong here; the implementation is
      // right and this assertion ratifies it.
      c05Variant('v2-dup-keys', Buffer.from('---\ntags: alpha\ntags: beta\n---\n', 'utf-8'),
                 '{"tags":"alpha"}');

      // v3: tab-indented key — KEY_RE anchors at column 0, so the line is
      // not key-shaped at all. DECLARED SIMPLIFICATION, ratified: rescuing
      // leading whitespace risks misclassing indented continuation lines
      // as top-level keys on clean frontmatter. Null, by doctrine.
      c05Variant('v3-tab-key', Buffer.from('---\n\ttags:\talpha\n---\n', 'utf-8'), null);

      // v4: '---' inside a YAML value — a FEATURE, not a degradation. The
      // value's '---' is not a closing delimiter (only a bare '---' line
      // closes); partition and parse both behave, and a wrong close here
      // would corrupt every downstream offset. Assert the recovered fm.
      c05Variant('v4-dashes-in-value',
                 Buffer.from('---\ndescription: value with --- inside\n---\n', 'utf-8'),
                 '{"description":"value with --- inside"}');

      // v5: nested/junk key — unknown keys ignored, not fatal, fm null.
      c05Variant('v5-nested-junk', Buffer.from('---\nnested: { a: [1, 2 }\n---\n', 'utf-8'),
                 null);

      // Negative control: CLEAN frontmatter parses fully — proves the
      // degeneracy nulls above are the parser degrading, not the fixture
      // failing to assemble a parseable document.
      const cleanFm = Buffer.from(
            '---\ntype: note\ntags:\n  - alpha\n  - beta\naliases: Gamma\ndescription: Delta\n---\n',
            'utf-8');
      c05Variant('v-clean-control', cleanFm,
                 '{"aliases":"Gamma","description":"Delta","tags":["alpha","beta"],"type":"note"}');

      console.log('C05: per-variant expected fm enforced (v2/v4 ratified, spec blanket criterion superseded)');
}

// -----------------------------------------------------------------------------
// C06 — Rename invariant + bridge emission (log lane)
// -----------------------------------------------------------------------------

async function c06RenameAndBridge(): Promise<void> {
      // Reuse C01's monster: same construction, independent assembly.
      let body = '';
      while (body.length < CEILING_BYTES * 3) body += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' + 'XYZ';
      const monolith = Buffer.from(body, 'utf-8');
      const PATH_A = 'notes/monolith-a.md';
      const PATH_B = 'vault-moved/monolith-b.md';

      const res = chunkNote(monolith);

      // ---- (a) Bridge parity: chunker output vs crossed events ----
      const sinkA = new RecordingSink();
      const summaryA = await emitChunkResult(sinkA, PATH_A, res);

      check('C06(a) summary indexed == pieces', summaryA.indexed === res.chunks.length,
            `${summaryA.indexed} vs ${res.chunks.length}`);
      check('C06(a) summary integrity == carves', summaryA.integrity === res.carves.length,
            `${summaryA.integrity} vs ${res.carves.length}`);
      check('C06(a) summary refusedEmpty == 0', summaryA.refusedEmpty === 0);

      const indexedA = sinkA.of('chunk.indexed');
      check(`C06(a) chunk.indexed count == ${res.chunks.length}`,
            indexedA.length === res.chunks.length, `${indexedA.length}`);

      // Payload parity: field-for-field against the chunker's own spans.
      // vh equality here closes the loop: the log's record of the hash
      // IS the chunker's hash, no serialization drift on the way across.
      for (let i = 0; i < indexedA.length; i++) {
            const ev = indexedA[i];
            const c  = res.chunks[i];
            if (ev === undefined || c === undefined) continue;
            const p = ev.payload;
            check(`C06(a) ord ${i} path`, p.path === PATH_A, `${p.path}`);
            check(`C06(a) ord ${i} ord`, p.ord === c.ord, `${p.ord} vs ${c.ord}`);
            check(`C06(a) ord ${i} bs`, p.bs === c.bs, `${p.bs} vs ${c.bs}`);
            check(`C06(a) ord ${i} be`, p.be === c.be, `${p.be} vs ${c.be}`);
            check(`C06(a) ord ${i} vh`, p.vh === c.vh, `${p.vh} vs ${c.vh}`);
            check(`C06(a) ord ${i} cp`, p.cp === c.cp, `${p.cp} vs ${c.cp}`);
      }

      // Emission order: all chunk.indexed BEFORE all log.integrity —
      // a reader tailing the shard meets spans before complaints.
      const firstIntegrityIdx = sinkA.events.findIndex(e => e.type === 'log.integrity');
      const lastIndexedIdx =
      sinkA.events.reduce((acc, e, i) => (e.type === 'chunk.indexed' ? i : acc), -1);
      check('C06(a) chunks precede integrity events',
            firstIntegrityIdx === -1 || lastIndexedIdx < firstIntegrityIdx,
            `lastIndexed=${lastIndexedIdx} firstIntegrity=${firstIntegrityIdx}`);

      // Carve details: ruling 5 — the piece span and the paragraph end are
      // NAMED APART. A reader must never conflate carve.be with the piece's
      // own end. (piece=i is the module's paired-with-chunks[i] inference,
      // flagged there; if this reds, the pairing assumption is the suspect.)
      const integA = sinkA.of('log.integrity');
      check(`C06(a) integrity count == ${res.carves.length}`,
            integA.length === res.carves.length, `${integA.length}`);
      for (let i = 0; i < integA.length; i++) {
            const ev = integA[i];
            const car = res.carves[i];
            if (ev === undefined || car === undefined) continue;
            const d = ev.detail ?? '';
            check(`C06(a) carve ${i} names the paragraph end`,
                  d.includes(`paragraph_end=${car.be}`), d);
            check(`C06(a) carve ${i} names the piece span`,
                  d.includes(`span=[${res.chunks[i]?.bs},${res.chunks[i]?.be})`), d);
                  check(`C06(a) carve ${i} names piece count`,
                        d.includes(`pieces=${res.chunks.length}`), d);
                  check(`C06(a) carve ${i} names the path`, d.includes(PATH_A), d);
                  check(`C06(a) carve ${i} names the reason`,
                        d.includes(`reason=${car.reason}`), d);
      }

      // ---- (b) Rename invariant: same bytes, second path ----
      const sinkB = new RecordingSink();
      const summaryB = await emitChunkResult(sinkB, PATH_B, chunkNote(monolith));

      check('C06(b) summaries agree across paths',
            summaryB.indexed === summaryA.indexed &&
            summaryB.integrity === summaryA.integrity &&
            summaryB.refusedEmpty === summaryA.refusedEmpty,
            JSON.stringify(summaryB));

      const indexedB = sinkB.of('chunk.indexed');

      // The invariant itself: vh sets IDENTICAL, every vh under BOTH
      // paths, and no vh collision-fused (each path's ords stay distinct).
      const vhsA = new Set(indexedA.map(e => e.payload.vh as string));
      const vhsB = new Set(indexedB.map(e => e.payload.vh as string));
      check('C06(b) vh sets identical across paths',
            vhsA.size === vhsB.size &&
            [...vhsA].every(v => vhsB.has(v)),
            `A=${vhsA.size} B=${vhsB.size}`);

      for (const vh of vhsA) {
            const pathsA = indexedA.filter(e => e.payload.vh === vh).map(e => e.payload.path);
            const pathsB = indexedB.filter(e => e.payload.vh === vh).map(e => e.payload.path);
            check(`C06(b) vh under path A`, pathsA.length > 0);
            check(`C06(b) vh under path B`, pathsB.length > 0);
      }

      // Only path differs: spans and ords identical modulo the path field.
      for (let i = 0; i < Math.min(indexedA.length, indexedB.length); i++) {
            const a = indexedA[i]?.payload;
            const b = indexedB[i]?.payload;
            if (a === undefined || b === undefined) continue;
            check(`C06(b) ord ${i} spans equal`, a.bs === b.bs && a.be === b.be,
                  `[${a.bs},${a.be}) vs [${b.bs},${b.be})`);
                  check(`C06(b) ord ${i} ord equal`, a.ord === b.ord);
                  check(`C06(b) ord ${i} path differs (it is a rename)`,
                        a.path !== b.path, `${a.path} == ${b.path}`);
      }

      // ---- (c) Refused-empty guard is live, not decorative ----
      const sinkC = new RecordingSink();
      const ghost: Chunk = {
            ord: 0, bs: 42, be: 42, vh: 'deadbeef', cp: 2, chain: [],
      } as unknown as Chunk;
      const accepted = await emitChunkIndexed(sinkC, 'notes/ghost.md', ghost);
      check('C06(c) empty span refused', accepted === false);
      check('C06(c) no chunk.indexed for ghost',
            sinkC.of('chunk.indexed').length === 0,
            `${sinkC.of('chunk.indexed').length}`);
      const integC = sinkC.of('log.integrity');
      check('C06(c) one integrity event', integC.length === 1, `${integC.length}`);
      check('C06(c) detail names the ghost',
            (integC[0]?.detail ?? '').includes('chunk.empty'),
            integC[0]?.detail ?? '');

      // ---- (d) Zero-chunk silence: contentless note crosses quietly ----
      const sinkD = new RecordingSink();
      const headOnly = chunkNote(Buffer.from('# Lonely\n', 'utf-8'));
      const summaryD = await emitChunkResult(sinkD, 'notes/lonely.md', headOnly);
      check('C06(d) zero indexed', summaryD.indexed === 0);
      check('C06(d) zero integrity', summaryD.integrity === 0);
      check('C06(d) zero events total', sinkD.events.length === 0,
            `${sinkD.events.length}`);

      console.log('C06: bridge parity held, rename invariant held, guards live');
}

// -----------------------------------------------------------------------------
// Registry + main
// -----------------------------------------------------------------------------

const FIXTURES: Array<{ id: string; run: () => void | Promise<void> }> = [
      { id: 'C01', run: c01Monolith },
{ id: 'C02', run: c02Fences },
{ id: 'C03', run: c03 },
{ id: 'C04', run: c04HeadingOnly },
{ id: 'C05', run: c05FrontmatterDegeneracies },
{ id: 'C06', run: c06RenameAndBridge },
];

// ONE main call. The 17:04 run invoked it twice — every line doubled,
// every tally cross-contaminated, and [C05] RED was libelled by run
// two's C06. Never again.
async function main(): Promise<void> {
      for (const f of FIXTURES) {
            const failBefore = failures;
            await f.run();
            console.log(`[${f.id}] ${failures === failBefore ? 'GREEN' : 'RED'}`);
      }
      console.log('');
      if (failures === 0) {
            console.log(`CSUITE: ALL GREEN (${checks} checks, ${FIXTURES.length} fixtures)`);
      } else {
            console.log(`CSUITE: ${failures} RED (out of ${checks} checks)`);
      }
}

main().then(() => {
      if (failures > 0) process.exitCode = 1;
});
