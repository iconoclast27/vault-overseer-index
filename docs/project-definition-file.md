---
source: Lumo-generated
status: pending
para:
context:
description:
Topics:
Concepts:
Meeting notes:
Permanent: false
type: note
word_count: 1
language: en
updated:
modified: 2026-10-18T15:52:28+01:00
aliases:
  - Project Vault Overseer
---
---

# Vault Overseer — Project Definition

**Status:** Active — planning phase **Type:** Obsidian plugin project (two plugins) **Working title:** Vault Overseer (FOVEYE, affectionately)

## Purpose

Build a local-first semantic index and LLM assistant for the vault, replacing the jobs currently done by Vector Search and Vault Curate — then growing into a full standalone vault assistant. Built as a longer-term project: **the goal is the tools and skills built along the way, not just the artifact.**

Core jobs:

- Fuzzy search across the vault
- Related notes, even if not linked
- LLM note maintenance: generate descriptions and frontmatter, tag per taxonomy, set parent relationships
- Background vault-health scan producing a problem report
- Later: knowledge capture and RAG

## Philosophy

- The build manufactures ground truth. Fixtures, event logs, property tests, and traces make LLM-assisted development verifiable instead of hopeful.
- Qwen is an apprentice supervised by instruments, not an oracle consulted with generic prompts.
- Conventional stack, chosen deliberately for maximum documentation and LLM familiarity.
- Infrastructure is seductive procrastination; every phase needs a blunt "done means this runs and I can see it."
- Step-by-step execution with verification; no running ahead of evidence.

## Constraints (locked)

1. **Obsidian Sync** is the transport. Settings configured: sync installed plugins + settings, **not** the enabled-plugins list — enablement is per-device and is the sanctioned mechanism for plugin topology.
2. **Everything lives in the plugin folder** so it syncs and backs up: settings, event log, index. Exceptions only for true host-level dependencies (Ollama, models, OS caches).
3. **Two plugins:**
    - **Plugin 1 (Vault Overseer Index)** — index, search, related notes. Active on both machines (Mokka desktop, Latitude 5400).
    - **Plugin 2 (Vault Overseer Assistant)** — LLM jobs. Desktop only; simply never enabled elsewhere.
4. **Plugin 1 must remain useful with Ollama down** — lexical search survives, semantic features degrade gracefully.
5. Distribution: **private by default**, installed via BRAT on both machines. Community release is a non-goal for now — see Open Questions.

## Architecture

### Layered, event-sourced

* **Layer 0 — Event log (spine).** Append-only JSONL, the synced source of truth. **Per-origin shards** (`_vault-index/events/{origin}.jsonl`), one writer per shard, merge-scan ordered by `(origin, seq)`. Human-readable in micro, greppable, replayable. Records file/chunk/link events plus integrity and checkpoint lines. Chunk text is **not synced**; only metadata (offsets, hashes) rides the spine.
* **Layer 1 — Projection (per-device, derived).** `better-sqlite3` + FTS5, derived from the log. Rebuildable at any time; disposable by design. Vectors, BM25, kNN-graph live in Zone 2 (plugin folder, structurally excluded from Sync).
* **Layer 2 — Assistant (Plugin 2).** HTTP to local Ollama, consumes Plugin 1's Retriever API. Batch jobs: gather → propose → diff review → approve → write via `app.vault`.

### Storage contract

* **Synced (in visible vault, \_vault-index/):** event log (per-origin shards), recipes, skills (overrides).
* **Synced (in plugin folder, quartet only):** `manifest.json`, `main.js`, `styles.css`, `data.json`.
* **Structurally excluded (plugin folder, never transported):** `cache/` subtree (vectors, BM25, kNN-graph). Rebuildable caches never travel.
* **Local-only per device:** vector payloads (deterministically re-derivable — same text + same model = same vector); origin identity (`origin.txt` in plugin folder, non-canonical, BRAT-proof).

**Verification tooling:** hostile fixtures corpus (every vault bug becomes a fixture before it's fixed), property tests (chunk offsets must reproduce chunk text — the killer invariant), two-level logging (terse info + reconstructive trace), test vault.

**Chunking:** paragraph-level, nearest-heading chain and frontmatter context attached, byte offsets recorded for citation jumps.

## Locked decisions

|Decision|Choice|Rationale|
|---|---|---|
|Language|TypeScript, esbuild, standard Obsidian template|Max examples, max docs, max Qwen familiarity|
|Database|better-sqlite3 + FTS5 (external content, trigram tokenizer)|Satisfies full constraint set after database tour; JSONL log + atomic writes borrowed from the losers|
|Vectors|Brute-force kNN in JS, no ANN/sqlite-vec|5,527 files — jet engine on a bicycle otherwise|
|Embedding model|`nomic-embed-text:v1.5`, both machines|Already proven in existing plugins; runs on Latitude CPU|
|Dimensions|768 native|Scale trivially permits it; MTEB 62.28|
|Prefixes|`search_document:` on index + related-notes (both sides); `search_query:` on RAG queries|Required by model card; Nomic's symmetric/asymmetric split; our responsibility since raw Ollama doesn't add prefixes|
|Sync profile|Obsidian Sync Plus: 10 GB / 200 MB per file|Text-only payload nowhere near limits|
|Vectors synced?|No — locally derived|Determinism makes them recomputable; zero sync traffic, zero corruption risk; model-mismatch → rebuild, loudly|

## Phases

1. Plugin 1 skeleton: scaffold, BRAT-installable, event log, file watcher, incremental pipeline — _plus the five-minute sync experiment: does an arbitrary file in the plugin folder propagate? If not, index relocates to a visible vault folder_
2. Chunker + FTS5 fuzzy search (with fixture corpus and property tests from day one)
3. Embeddings + related notes sidebar (two-tab sidebar: Search / Related)
4. Plugin 2 scaffold + single-note jobs: description, frontmatter per template, tagging per Taxonomy note
5. Maintenance job runner: batch jobs with diff-review approval; catch-up behavior on desktop convergence ("ensure notes in {folder} have frontmatter like {template}", "tag per taxonomy", "set parent")
6. Background vault-health scan → report
7. RAG chat and knowledge capture

## Wishlist (unscheduled)

- Atomised note generation
- MCP server exposing the index to any local client
- Relationship map — **explicitly deprioritized** ("not so fussed")

## Hardware & environment

- **Mokka desktop:** Garuda Linux x86_64, RTX 4070 — all layers, heavy work, Ollama with full model set
- **Latitude 5400:** Garuda Linux — Ollama with limited models (nomic for indexing; qwen3.5:4b for interpretation)
- Shell: fish; editor: micro

## Working rhythm

- Weekly minimum session, evening sessions as available; small chunks suit the project
- Qwen as editor-integrated assistant with explicit capability expectations: tagging, frontmatter fixing, atomised note generation
- Session notes and decisions land in the project folder; this chat is working memory until checkpoints

## Open questions

- **Final name** — "Vault Overseer" is a working joke title
- **Community release** — deferred. Known cost: users want updates and have expectations. Decided for now: BRAT-only, private repo
- **Plugin-folder sync of arbitrary files** — resolved by experiment in phase 1
- **Taxonomy note schema / template conventions** for maintenance jobs — phase 4 concern

---

