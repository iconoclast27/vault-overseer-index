// =============================================================================
// Vault Overseer — Spine Projection (live path set)
// src/eventlog/projection.ts
// Created: 2026-10-25
//
// Single-implementation extraction from heal.ts (rev 2026-10-25), per the
// renderEmbedInput precedent: two consumers of the same event-walk would
// drift. Consumers:
//   - healScan (every boot — which paths to re-chunk)
//   - reconcile (first-contact backfill + manual settings button, planned)
//   - the future index's projection seam (Plugin 2)
//
// Semantics (LIVE-SET, subtractive — the fix heal.ts owed):
//   note.created / note.modified   => path is live
//   note.renamed                   => 'from' dies, 'to' is live
//   note.deleted                    => path dies
//
// The fold is ORDERED (seq order); the caller supplies scan.events in
// spine order. Resurrection is honored by construction: a created path
// that died can re-enter the live set via a later created/modified/
// renamed-to — the set is state, not history.
//
// OUT OF SCOPE (visible, owed):
//   - Restored-file divergence (spine says dead, disk says alive) is
//     reconcile's ruling, not the projection's — the projection only
//     reports spine truth.
//   - chunk coverage maps stay with their consumer until a second
//     consumer exists.
//
// Node note: erasable TypeScript only; imports spell out .ts extensions.
// =============================================================================

import type { ParsedLine } from './reader.ts';

export interface PathProjection {
    /** Paths the spine declares LIVE after the full ordered fold. */
    livePaths: Set<string>;
    /** Paths that lived and died — autopsy count, for receipts. */
    deadPaths: Set<string>;
}

/**
 * Ordered fold over spine events producing the live path set.
 * Unknown event types are ignored (forward-compat: foreign types must
 * not crash the projection; heal's own refusal lane polices gaps).
 */
export function projectPaths(events: ParsedLine[]): PathProjection {
    const livePaths = new Set<string>();
    const deadPaths = new Set<string>();

    for (const e of events) {
        const t = String(e.type);
        if (t === 'note.created' || t === 'note.modified') {
            if (typeof e.path === 'string') {
                livePaths.add(e.path);
                deadPaths.delete(e.path); // resurrection
            }
        } else if (t === 'note.renamed') {
            if (typeof e.from === 'string') {
                livePaths.delete(e.from);
                deadPaths.add(e.from);
            }
            if (typeof e.to === 'string') {
                livePaths.add(e.to);
                deadPaths.delete(e.to); // destination is born live
            }
        } else if (t === 'note.deleted') {
            if (typeof e.path === 'string') {
                livePaths.delete(e.path);
                deadPaths.add(e.path);
            }
        }
    }

    return { livePaths, deadPaths };
}
