# Vault Overseer Index

Local-first semantic search and event-log spine for Obsidian. Two-plugin architecture: Plugin 1 builds a durable, sync-free machine-switching event log; Plugin 2 (future) consumes its Retriever API for batch jobs.

**Design goals:** sync-free machine switching (per-origin shards), append-only spine with checkpoint chains, threshold-only dwell gating, path-remapping on rename without re-embed, paragraph-level heading-chained chunking.

**Docs:** See [`./docs/`](./docs/) for the full schema family (Event Log Schema, Fixture Corpus, Chunker Spec, Architecture Map, Project Definition, Tool & Skill Strategy).

**License:** Personal/experimental use. No warranty; use at your own risk. Issues are disabled.