# Explicit note links and queryable backlinks

Date: 4 October 2026. Status: proposed design; documents only.

## Problem

`apps/electron/electron/main/services/notes.ts:20` defines note content and linked-source fields.
`notes.ts:181` updates notes while preserving owner corrections.
`apps/electron/electron/main/services/note-intelligence.ts:204` finds related items.
That is a semantic relationship path; it does not materialize authored Markdown backlinks.
`apps/electron/electron/main/services/knowledge-graph-service.ts:845` filters relationships
by connecting-edge provenance, which explicit relationships also need to preserve.
`knowledge-graph-service.ts:957` exposes graph nodes through service DTOs.
The inspected note services contain no explicit wiki-link backlink table or parser.
This adoption adds a deterministic authored-link layer beside the inferred graph.

The owner supplies about 2,100 recordings and 240,000 chunks as the corpus scale.
The current note count and explicit-link density are to verify.
`notes.ts:57` caps one note at 1 MiB, so parsing must remain bounded.
No backlink count or parser benchmark has been observed in this task.

## What the open-source project does

SilverBullet's `plugs/index/relation.ts` extracts relation objects with source ranges.
Its records include from/to targets, relation kind, source page and optional aliases.
`plugs/index/link.ts` projects link objects from relation records.
It excludes co-mention relations from that projection.
`plugs/index/indexer.ts` replaces indexed objects for the changed page.
Take authored-link provenance, source offsets and source-slice replacement.
Represent the reverse query as backlinks over the same directed rows.
Keep semantic co-mentions and inferred identity separate from explicit authored links.
HiDock needs a small Markdown extractor and SQLite queries, without Space Lua or PlugOS.

SilverBullet is MIT, Copyright 2022 Zef Hemel (`LICENSE.md`).
Copied or adapted parser code must include the copyright and permission notice.
Ship that notice with substantial derived code; record inspiration for independent implementation.
This document does not copy its runtime or install dependencies.

## Goals and non-goals

- Query incoming authored links from notes to notes, recordings, people and projects.
- Preserve aliases, authored spelling and an inspectable source snippet.
- Recompute only one note's relations when its content changes.
- Resolve stable IDs deterministically and keep ambiguous names unresolved.
- Present explicit and inferred relations with clear provenance.
- Honour deletion, owner exclusion and privacy at query and model boundaries.
- Avoid LLM calls for parsing or resolution.
- Exclude crawling external URLs, downloading attachments and auto-creating contacts.
- Exclude inferred co-mention expansion and backlinks from generated summaries.
- Keep a general query language and scripting outside scope.

## Design

### Components and data model

Add a proposed Markdown relation extractor and backlink repository in main services.
The next migration creates `note_relations`, an additive derived table.
Columns: ID, source note ID, content revision, occurrence ordinal and relation kind.
Also store target kind, resolved target ID, raw target, alias and start/end offsets.
Store a <=240-character source snippet, resolution state and resolver version.
Kinds are explicit link or explicit mention; origin is always `user-text`.
Unique `(source_note_id, content_revision, occurrence_ordinal)` prevents retry duplicates.
Index `(target_kind, target_id, source_note_id)` for incoming links.
Index source note ID for replacement and unresolved normalized target for retry resolution.
Keep repeated occurrences for navigation while grouping backlinks by source note in the UI.
Offsets are UTF-16 code units to align with renderer text positions.
The exact editor selection API is to verify before wiring jump-to-occurrence.
Source note existence is a foreign-key constraint where existing deletion behavior permits it.
Use the existing note deletion transaction to clear its derived relations.
No reverse duplicate row is stored; incoming links query the target index.

### Syntax and resolution

Support `[[note:<id>|label]]`, `[[recording:<id>]]`, `[[person:<id>]]` and `[[project:<id>]]`.
These are proposed HiDock syntaxes, not existing link formats.
Support `[[Title]]` as a note-title reference only when one visible exact title resolves.
Support `@{person:<id>|label}` and `@{project:<id>|label}` as explicit typed mentions.
Plain `@Maria` stays text until the owner chooses a unique typed mention.
Allow Markdown links to the same typed destinations once the parser recognizes them.
External HTTP(S) links can be recorded as outbound references without local backlinks.
Do not treat URL substrings, emails or code samples as person mentions.
Ignore fenced code, inline code, escaped delimiters and HTML comments.
Normalize title lookup with Unicode normalization and case folding.
Preserve the original target spelling; do not rewrite note bodies on resolution.
Unknown IDs and ambiguous titles stay unresolved and remain visible to the source owner.
Never resolve a name against a hidden target through a title fallback.
Resolve aliases solely as display text; aliases grant no identity authority.
Cap extraction at 2,000 relations per note and report overflow explicitly.

### Exact save and query flow

1. Commit the authored note through the existing `updateNote` path.
2. Queue its latest content fingerprint (`notes.ts:107`) for relation extraction.
3. Parse a snapshot in a worker when the note exceeds the small synchronous budget.
4. Resolve typed targets and exact titles through bounded local queries.
5. Re-read the note fingerprint before writing derived rows.
6. If changed, discard stale staging and queue the latest revision.
7. In one transaction, replace only this note's relation slice.
8. Publish the note's relation revision and invalidate its backlink view cache.
9. Query backlinks by target index, joining current visible source notes.
10. Apply target and source eligibility before pagination and grouping.
11. Return source ID, display title, relation type, count and snippet with offsets.
12. Recheck source visibility before navigation, RAG inclusion or graph projection.

If extraction fails, preserve the last derived generation but label it stale.
A stale row is excluded from model context and hidden when its source revision differs.
An empty new note body publishes an empty relation slice.
Target renames preserve ID links and queue only unresolved title resolutions.
Target deletion leaves a dangling authored reference; do not delete authored text.
Contact merge redirects query resolution through the existing journalled identity mapping.
Undo must restore the previous typed target interpretation without rewriting the note.
The available contact redirect API is to verify in the implementation PR.
Never merge contacts merely because a note uses the same display name.

### Integration and settings

`note-intelligence.ts` may display inferred related items below explicit links.
It cannot overwrite explicit relations or promote its output to `user-text` provenance.
`knowledge-graph-service.ts` projects explicit edges with relation IDs and source note IDs.
Avoid storing a second persistent graph copy until its schema/provenance path is verified.
The first release uses a query-time graph overlay backed by `note_relations`.
Graph queries retain connecting-edge eligibility, including source note visibility.
Add proposed `notes.backlinksEnabled=false` to AppConfig during rollout.
Persist in `<userData>\config.json` (`services/config.ts:491`).
Show Backlinks in note/person/project/recording detail views only when enabled.
Show unresolved targets in the source note; offer explicit target selection.
No cloud model or automatic repair is invoked by that selection.
Backlink snippets inherit the source note's privacy tier under adoption 8.

## Performance and leanness budget

These limits are acceptance targets; exact note density remains to verify.

| Measure | Target | Measurement |
|---|---|---|
| Resident overhead | <=8 MiB steady; <=16 MiB parser peak | RSS/heap during maximum-size note edit |
| Startup overhead | <=3 ms p95 | 20 cold/warm starts with prebuilt relation rows |
| Backlink query | <=30 ms p95 for 50 visible sources | Real adapter timing with dense target fixtures |
| Added Search overhead | <=2 ms p95 | Search on full 240,000-chunk snapshot during parsing |
| Disk growth | <=50 MiB per 100,000 occurrences | Persisted row/index page deltas |
| Event-loop delay | <=5 ms p95 added; <=8 ms slices | Monitor edit storms and active USB transfer |

Benchmark the actual 2,100-recording library and its measured note count.
Add synthetic high-density notes to test the parser and target-index tail.
One low-priority parser/backfill job runs at a time.
Chunk worker output into at most 250 relation rows per staging batch.
Yield with `setImmediate` between main-writer batches; atomic publication remains brief.
Pause backfill for foreground note save, search, transcription and device work.
No full-note parsing or relation backfill runs at startup.
Cache only bounded backlink result pages, never all source note content.

## Test plan

Write the following failing tests first.

- `backlinks.typed-link-and-alias`: incoming link retains its authored alias and range.
- `backlinks.explicit-mention`: typed person mention resolves without an LLM.
- `backlinks.code-and-escape`: code, comments, escapes and emails produce no relations.
- `backlinks.ambiguous-title`: duplicate visible titles remain unresolved.
- `backlinks.utf16-range`: emoji and CRLF offsets select the correct source text.
- `backlinks.replace-one-note`: editing one note leaves every other source slice unchanged.
- `backlinks.stale-worker`: stale extraction never overwrites a newer note generation.
- `backlinks.hidden-source`: invisible source rows do not affect counts or pagination.
- `backlinks.dangling-target`: deleted target does not remove authored text.
- `backlinks.identity-undo`: merge/undo retains stable authored relation provenance.
- `backlinks.no-inferred-promotion`: AI relationships cannot become explicit rows.

Use actual better-sqlite3 migration, note save, relation publication and backlink reads.
Force transaction failure during slice publication; the old complete slice remains readable.
Reopen after a crash and verify queued latest revisions reconcile deterministically.
Exercise note editing and jump-to-occurrence in the real Electron renderer.
Compare graph overlay labels with inferred edge labels and their visibility rules.
Benchmark actual note density plus the 100,000-occurrence fixture against the budgets.

## Rollout

1. PR 1: syntax/parser tests, additive relation schema and repository queries.
2. PR 2: revision-safe note hooks, dangling resolution and bounded backfill.
3. PR 3: Backlinks detail views and explicit graph overlay behind the setting.

Backfill existing authored notes only, ten first and then one idle note at a time.
Generated summaries and transcript text are outside relation extraction.
Rollback disables parsing and views; retain authored notes and derived rows.
Re-enable reconciles source fingerprints before showing stored backlinks.
No graph-wide rebuild, schema downgrade or source deletion is required.

## Risks and open decisions

Freeform names can collide with contact aliases and title normalization.
Storing snippets duplicates private authored text; keep them bounded and policy-protected.
Identity redirect and editor selection boundaries are to verify before implementation.

- Recommended **typed**. Mentions: **typed** or **bare**?
  Typed costs target selection; bare requires ambiguity UI and increases false links.
- Recommended **overlay**. Graph integration: **overlay** or **persist**?
  Overlay costs indexed reads; persist adds graph schema, duplicate state and reconciliation.
- Recommended **exact**. Title resolution: **exact** or **fuzzy**?
  Exact leaves more unresolved links; fuzzy adds candidate ranking and owner confirmation.
