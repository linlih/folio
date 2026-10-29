# loro-prosemirror (vendored)

- Upstream: https://github.com/loro-dev/loro-prosemirror, version 0.4.4 (npm), MIT (see `LICENSE`).
- Why vendored: 0.x with a single maintainer, and Folio needs a patch
  (design/ARCHITECTURE.md §5.1 point 5).
- Regression tests that must pass after any upgrade: `web/test/editor-*.test.ts`
  and `web/test/journal-merge.test.ts`; the spike's correctness tests in
  `spike/web/test` are the longer reference.

## Changes from upstream

1. Imports of `prosemirror-model|state|view|transform` point at `@tiptap/pm/*`
   so there is exactly one ProseMirror instance.
2. `getLoroMapAttributes` / `getLoroMapChildren` (`lib.ts`) create the node's
   `attributes` / `children` with `ensureMergeableMap` / `ensureMergeableList`
   instead of `getOrCreateContainer` (§4.5 rule 2). An existing plain container
   is reused, because `ensureMergeable*` throws on a key that holds one.

3. `LoroUndoPlugin` takes `takeStepTag` / `onTaggedStep` (`undo-plugin.ts`,
   `undo-plugin-key.ts`): an operation that also changed other documents
   (extracting a block into a new card) tags its undo step, and undoing or
   redoing that step, by any route, applies the other documents' side too
   (§5.1 cross-document undo).

4. `createNodeFromLoroObj` (`lib.ts`) fills content that does not fit the
   schema with `createAndFill` instead of dropping the node: a new card's
   empty body, an empty list after a concurrent edit (§5.1 point 4).

5. Layout 2 (`lib.ts`, `cursor/common.ts`): the body root is `body`, node
   children are mergeable `LoroMovableList`s, and block containers are
   aligned by block id with `move` instead of positional rewriting (§4.5
   rule 4). Text blocks keep the positional inline diff.

6. Several views on one LoroDoc (`sync-plugin.ts`, `lib.ts`, `undo-plugin.ts`),
   for the same card in both panes of a split view: each view commits under
   its own origin (`loroSyncPlugin:<n>`) and applies the other views' local
   commits like imports; views sharing an `UndoManager` share one pair of
   undo hooks, which act for the view last focused, edited or undoing.
   Tests: `web/test/split.test.ts`.

7. Local commits under `app:` origins (`APP_EDIT_ORIGIN`, `sync-plugin.ts`)
   are body edits made outside editors (restoring a backup version); every
   view applies them. Test: `web/test/restore.test.ts`.

8. Layout 3 (`tree.ts`, `sync-plugin.ts`, `cursor/common.ts`; replaces the
   block part of patch 5): a card's blocks are nodes of a LoroTree (root
   `blocks`). Text blocks keep their inline content in a mergeable movable
   list `children` on the node's data map; container blocks use the tree's
   children. Writing finds blocks by id across the whole tree and moves them
   to their new parent, so cross-parent moves keep identity; unchanged
   blocks are skipped by identity of their ProseMirror node; empty wrappers
   left by merges are not shown. Cursors map through the tree.
   Tests: `web/test/move-concurrent.test.ts`, `web/test/split.test.ts`, and
   the Rust fixtures in `crates/folio-core/tests/editor_fixtures.rs`.

9. Selections in states the binding never synced (`cursor/common.ts`,
   `undo-plugin.ts`). The binding syncs in a transaction it appends, so when
   another plugin appends one first (BlockId giving a new line its id), the
   undo plugin saw a state whose new line it could not find: it logged
   "Cannot find the loroNode" on every Enter and forgot the selection before
   the change. Converting with `quiet` reports such a miss, and the undo
   plugin keeps the selection from the last synced state. Test:
   `web/test/cursor-mapping.test.ts`.
10. Selections on a block that holds blocks (`cursor/common.ts`). In layout
   3 only text blocks keep a children list, so a selection whose parent is a
   list item (a selected image, a file block) has no text cursor: it maps to
   none instead of throwing, which dropped the transaction. Selecting an
   image and deleting it removed it on screen but not in the document, so
   the deletion never synced. Test: `web/test/asset-delete.test.ts`.
11. Cursors in deleted blocks (`tree.ts`, `cursor/common.ts`,
   `sync-plugin.ts`). An update that deletes the line the cursor is on (undo
   of typing that made a new line) left the saved cursor in a deleted tree
   node; mapping it asked Loro for the parent of a deleted node, which
   throws ("TreeID(…) not found"). Such a cursor maps to no position and is
   not restored; the undo's own saved selection still is. Test:
   `web/test/cursor-mapping.test.ts`.

Search for `folio patch` to find every change in the code.
