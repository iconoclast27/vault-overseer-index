---
source:
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
modified: 2026-10-20T09:52:23+01:00
---
---
Good spot — the strategy lived scattered across a dozen conversations, mostly as reactions to S2B's crimes. Time it had a home. Here's the note, reconstructed from our sessions; I've flagged the two or three places where we left things genuinely undecided rather than papering over them, so fill or veto as you see fit.

---

# Tool & Skill Strategy
### How Vault Overseer's LLM is constrained — the "model judges, harness acts" doctrine

> [!abstract] Purpose
> Defines how the Assistant plugin (Plugin 2) invokes the LLM. Establishes that **the model never acts directly** — it fills in blanks inside pre-validated recipes, and the harness owns every side effect. Companion to the project definition note and the Lessons from the Incumbents note.

## Core principle

**The model judges; the harness acts.**

Every capability the LLM participates in is expressed as a **skill recipe** — a short, declarative Markdown file describing a task, its inputs, and its output contract. At runtime:

1. The harness selects and loads the recipe.
2. The recipe is rendered into the prompt with the model's judgment targets left blank.
3. The model returns **structured output conforming to the recipe's schema** — nothing more.
4. The harness validates the output against the schema and the vault's ground truth.
5. Only validated output proceeds to the diff view and, on approval, to application.

The model is never handed a menu of general tools. It is handed a **form**, already annotated with the values it needs to consider.

## The failure mode this kills

> [!warning] Observed in the wild
> Smart Second Brain gives its models a broad toolset, and the models respond by inventing tools that don't exist — `execute_javascript` et al. This is not a model defect; it's an architectural invitation. Give a model latitude and a menu, and it will order off-menu. (Lessons note, §1)

The recipe approach removes the invitation:

- **No discovery.** The model doesn't browse capabilities; it sees one task at a time.
- **No composition.** The model cannot chain skills or improvise steps; the harness chains, in deterministic order.
- **Schema-or-nothing.** Output that fails validation is rejected before it can touch a file. A hallucinated tool call is a syntax error, not a security incident.
- **Determinism where it's cheap.** File reads, searches, renames — anything mechanical — are done by the harness before the model ever sees the task. The model's context arrives pre-assembled.

## Anatomy of a skill recipe

Each recipe is a Markdown file with a fixed frontmatter-plus-body structure:

| Section | Contents |
|---|---|
| **Metadata** | Name, version, model fingerprint requirement (which model tier it expects), risk class |
| **Trigger** | How the skill is invoked: user command, command-palette entry, or harness-scheduled (e.g. nightly maintenance) |
| **Inputs** | What the harness gathers *before* prompting: file contents, search results, existing frontmatter, related notes |
| **Instructions** | The short, declarative body — the actual prompt fragment. Written to constrain, not inspire. No examples of forbidden behaviors. |
| **Output contract** | A schema the response must validate against (JSON schema, with strictness flags) |
| **Apply method** | Reference to the harness routine that executes validated output: frontmatter merge, note append, tag write, etc. |
| **Validation** | Post-model checks beyond schema — e.g. "all proposed tags must exist in the existing tag vocabulary or be flagged as new" |

> [!note] Risk classes
> Recipes are classified by blast radius: **read-only** (summarize, related notes), **suggest** (propose edits → diff view, user approves), **write** (auto-applied after validation — reserved for low-risk, reversible operations, if we allow this class at all).

## The diff gate

No LLM-produced edit reaches the vault without passing through the diff view — the user sees, in Obsidian's native diff format, exactly what will change, and approves or rejects. This is R10 and our clearest differentiator: no incumbent offers it. Even perfectly validated output faces human review before application, because schema-valid ≠ correct.

## Why recipes beat toolsets

| Broad toolset (S2B style) | Recipe-based (ours) |
|---|---|
| Model explores capabilities at runtime | Capabilities fixed at design time |
| Hallucinated tool calls executed or crash | Off-schema output dies in validation |
| Prompt assembled from tool descriptions | Prompt assembled from harness-gathered ground truth |
| Behavior varies with model mood | Judgment is the only variable; procedure is code |
| Debugging = archaeology | Debugging = inspect recipe + input + raw output triplet |

The deep argument: LLMs are unreliable *executors* but excellent *judges* of pre-framed choices. The recipe strategy puts the model exclusively in the judging seat — "here are this note's paragraphs and the existing vocabulary; which tags apply?" — and keeps every consequence in typed, tested, deterministic code.

## First candidate skills

To validate the architecture before building breadth, in rough order:

1. **Tag assignment** — propose tags for a note from existing vocabulary; flag novel tags distinctly. Simple schema, immediately useful, easy to grade.
2. **Frontmatter repair** — detect and fix malformed or missing frontmatter fields against a vault convention. Tests validation strictness.
3. **Related notes** — given the active note's chunks, propose `[[wikilinks]]` to semantically adjacent notes. Tests harness-assembled context.
4. **Summary digest** — period/folder summary note generation. Tests multi-input assembly.

Each ships only when its failure modes have been exercised on the test vault's pathological fixtures.

## Emergent recipes — the corrections notebook

Skills aren't all designed upfront. A lightweight observation loop promotes recurring fixes into formal recipes:

1. **Record** — model produces invalid output (off-schema, hallucinated tool, etc.) → log an entry in a corrections notebook
2. **Track recurrence** — each pattern accumulates a repeat count across sessions
3. **Promote** — patterns hitting a threshold (e.g. 4+) become candidate recipes, with the evidence trail preserved
4. **Feed back** — model can consult the notebook during work to self-check against known failure patterns

Entry format:

​```markdown
[Skill Pattern]
[Evidence]: 2026-10-19 | Model invented `execute_javascript` tool when asked to read a file
[Repeat count]: 4
[Tell]: "Model proposes tool not in skill folder"
[Remedy]: Only use tools defined in visible folder; if needed, request schema update
​```

Companion to, not replacement for, the fixture-corpus discipline: a fixture proves the *harness* handles a pathological input; a corrections entry proves the *model* needed correcting — recurring entries are free requirements discovery.

## Skill file residency

> [!decision] Resolved: **Plugin ships defaults; user folder (visible `_vault-index/skills/`) overrides by same-name precedence.** Matches the event-log philosophy: code delivers, vault remembers. Overrides sync across machines and survive reinstalls; plugin updates refresh defaults without clobbering user edits. See Architecture Map v0.2, Decisions table.

> [!decision] Resolved 2026-10-20 — write-class carve-out admitted, narrowly scoped
> **v1 allows a `write` risk class: validated output may auto-apply without diff review, but ONLY where all five guardrails hold.** Everything else routes through the diff gate as before. R10 is amended, not abandoned — the gate remains the default; the carve-out is a named exception with conditions.
>
> **Guardrails (all must hold):**
> 1. **Additive only** — may fill an *empty or missing* field; may never modify, overwrite, or delete an occupied one. No exceptions, no "minor corrections."
> 2. **Field-scoped** — operates on a single named frontmatter field. No whole-note rewrites, no body edits in v1.
> 3. **Prior value logged** — the event log records the pre-write state, making every auto-applied write individually revertible by replay. *(This is the structural advantage VC lacked: their ungated write left no undo trail; ours cannot, by construction.)*
> 4. **Surfaced, never silent** — auto-application emits a notice and an event-log entry. Silence was the incumbent's cardinal sin; invisibility is disqualifying.
> 5. **Auditable** — a review surface lists recent auto-applied writes for spot-checking and bulk revert.
>
> **Candidate v1 allowlist (to be finalised per recipe):** set `title` if missing; set `description` if empty. Tag *addition* is borderline — it alters searchability, so it stays `suggest` for v1 unless argued otherwise.
>
> **Rationale for admitting the class at all:** the diff gate's cost is human attention, and attention spent approving "filled an empty description field" is attention unavailable for reviewing judgment calls. Automating the trivial protects the gate's authority where it matters. Reversibility is what buys the licence — we can afford to be wrong cheaply.


> **Design note — staged capability:** Guardrail 1 (additive only) currently renders
> guardrail 3 (prior-value logging) near-vacuous: empty fields have no prior value
> to record. This is deliberate staging, not redundancy. The prior-value payload is
> mechanism laid now so that any future relaxation of guardrail 1 inherits revertibility
> by construction — the audit trail exists *before* the writes need it. Policy restricts;
> mechanism enables; never conflate removing a restriction with adding a capability.

## Scope guardrail

Recipes are for **curation and assistance** — bounded, single-pass, structurally validated tasks. Multi-step agentic wandering (chained reasoning across sessions, autonomous browsing of the vault) is explicitly out of scope for Vault Overseer v1. If a task can't be expressed as one recipe with one output contract, it's not a v1 skill.

---

## Relations

- [[Project Definition File]] → overall architecture
- [[Lessons from the Incumbents — Comparison Doc v2]] → §1 (S2B tool hallucinations), requirement R9, R10
- Requirement R12 (working method) → this note drafted per that discipline

Two things I'd like your ruling on before this note is considered closed: the **residency question** above, and whether we allow the **write-class** (auto-apply) recipes at all in v1, or force everything through the diff gate unconditionally. My instinct is the latter for v1 — one gate, no exceptions — and relax later if it proves tedious, but that's your call to make since it trades away automation.

