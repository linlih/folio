// folio patch: layout 3 (design/ARCHITECTURE.md §4.5 rule 4). A card's blocks
// live in a LoroTree: every block-level ProseMirror node is a tree node whose
// `data` map holds `nodeName` and mergeable `attributes`; text blocks also
// hold a mergeable movable list `children` with their inline content (texts
// and inline nodes, as in layout 2). Container blocks (lists, items, quotes)
// have the tree's children.
//
// Writing aligns ProseMirror's blocks with tree nodes by block id across the
// whole tree and moves nodes to their new parent and position, so a block
// moved to another parent (indent, outdent, drag, extract) keeps its
// identity and another device's concurrent edit to it is kept. Loro's tree
// keeps concurrent moves free of cycles and duplicates.

import type { ContainerID, LoroDoc, LoroEventBatch, LoroMap, LoroTree, LoroTreeNode, TreeID } from "loro-crdt";
import { isContainer } from "loro-crdt";
import type { Node, Schema } from "@tiptap/pm/model";
import {
  CHILDREN_KEY,
  LORO_SYNC_ORIGIN,
  createLoroChild,
  createNodeFromLoroObj,
  getLoroMapAttributes,
  getLoroMapChildren,
  type LoroNode,
  type LoroNodeMapping,
  NODE_NAME_KEY,
  updateLoroMapAttributes,
  updateLoroMapChildren,
  WEAK_NODE_TO_LORO_CONTAINER_MAPPING,
} from "./lib";

/** The root container of layout 3. */
export const TREE_ROOT_KEY = "blocks";

export function bodyTree(doc: LoroDoc): LoroTree {
  return doc.getTree(TREE_ROOT_KEY);
}

/** A tree node's id from its data map's container id (`cid:<id>:Map`). */
export function treeIdOfData(id: ContainerID): TreeID | null {
  const m = /^cid:(\d+@\d+):Map$/.exec(id);
  return m ? (m[1] as TreeID) : null;
}

const childrenOf = (tree: LoroTree, parent: LoroTreeNode | undefined): LoroTreeNode[] =>
  (parent ? parent.children() : tree.roots()) ?? [];

const nameOf = (node: LoroTreeNode): string => String(node.data.get(NODE_NAME_KEY) ?? "");

function bidOf(node: LoroTreeNode): string | null {
  const attrs = node.data.get("attributes");
  const bid = isContainer(attrs) ? (attrs as LoroMap).get("bid") : undefined;
  return typeof bid === "string" && bid ? bid : null;
}

const hasInline = (data: LoroMap) => isContainer(data.get(CHILDREN_KEY));

// ---- reading ----

/** The ProseMirror node for a tree node (cached in `mapping` by its data
 *  map's id); null for a node the schema doesn't know. */
export function buildBlock(schema: Schema, tree: LoroTree, node: LoroTreeNode, mapping: LoroNodeMapping): Node | null {
  const data = node.data as unknown as LoroNode;
  const cached = mapping.get(data.id);
  if (cached && !Array.isArray(cached)) return cached;
  const name = nameOf(node);
  const type = schema.nodes[name];
  if (!type) return null;
  const attrs = getLoroMapAttributes(data).toJSON();
  const content: Node[] = hasInline(data)
    ? getLoroMapChildren(data)
        .toArray()
        .flatMap((child) => createNodeFromLoroObj(schema, child as never, mapping) ?? [])
    : childrenOf(tree, node).flatMap((c) => buildBlock(schema, tree, c, mapping) ?? []);
  // A wrapper left empty by a merge (two devices each made a list for the
  // same indented block; it moved into one of them) is not shown; the next
  // local edit prunes it from the tree.
  if (!content.length && !type.inlineContent && !type.isLeaf && !getLoroMapAttributes(data).get("bid") && type.contentMatch.defaultType) {
    return null;
  }
  let pm: Node | null = null;
  try {
    pm = type.createChecked(attrs, content);
  } catch {
    // Content that does not fit (an empty list after a merge, a new card's
    // empty body) is filled with the minimum required nodes (patch 4).
    pm = type.createAndFill(attrs, content);
  }
  if (!pm) return null;
  mapping.set(data.id, pm);
  WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(pm, data.id);
  return pm;
}

/** The document's blocks, top level first. */
export function buildDocContent(schema: Schema, doc: LoroDoc, mapping: LoroNodeMapping): Node[] {
  const tree = bodyTree(doc);
  return tree.roots().flatMap((n) => buildBlock(schema, tree, n, mapping) ?? []);
}

// ---- writing ----

/** Block children of a ProseMirror node (text blocks have none). */
function blockChildren(node: Node): Node[] {
  if (node.type.inlineContent || node.isLeaf) return [];
  const out: Node[] = [];
  node.forEach((c) => void out.push(c));
  return out;
}

function initData(data: LoroNode, pm: Node, mapping: LoroNodeMapping) {
  data.set(NODE_NAME_KEY, pm.type.name);
  const attrs = getLoroMapAttributes(data);
  for (const [k, v] of Object.entries(pm.attrs)) if (v !== null) attrs.set(k, v);
  if (pm.type.inlineContent) {
    const list = getLoroMapChildren(data);
    // Same grouping of adjacent text nodes as layout 2.
    let texts: Node[] | null = null;
    const flush = () => {
      if (texts) createLoroChild(list, null, texts, mapping);
      texts = null;
    };
    pm.forEach((child) => {
      if (child.isText) (texts ??= []).push(child);
      else {
        flush();
        createLoroChild(list, null, child, mapping);
      }
    });
    flush();
  }
}

/** Makes the tree match `pmDoc`: blocks found by id anywhere in the tree are
 *  moved into place (keeping identity), blocks without one (lists) are
 *  matched by type and order under the same parent, new blocks are created,
 *  and tree nodes no block uses any more are deleted.
 *
 *  The work follows what changed: a block whose ProseMirror node is the one
 *  last synced is skipped without visiting its subtree, the node already in
 *  place is tried before any search, the whole-tree index of block ids is
 *  built only when a block has moved, and nodes are pruned only under
 *  parents whose content changed. */
export function syncTreeFromPm(doc: LoroDoc, pmDoc: Node, mapping: LoroNodeMapping) {
  const tree = bodyTree(doc);
  let byBid: Map<string, LoroTreeNode> | null = null;
  const findBid = (bid: string) => {
    if (!byBid) {
      byBid = new Map();
      const gather = (nodes: LoroTreeNode[]) => {
        for (const n of nodes) {
          const b = bidOf(n);
          if (b && !byBid!.has(b)) byBid!.set(b, n);
          gather(n.children() ?? []);
        }
      };
      gather(tree.roots());
    }
    return byBid.get(bid);
  };
  const used = new Set<TreeID>();
  /** Parents whose children were placed: their leftovers are pruned. */
  const placed: (LoroTreeNode | undefined)[] = [];

  const syncNode = (t: LoroTreeNode, pm: Node) => {
    const data = t.data as unknown as LoroNode;
    if (data.get(NODE_NAME_KEY) !== pm.type.name) data.set(NODE_NAME_KEY, pm.type.name);
    updateLoroMapAttributes(data, pm, mapping);
    if (pm.type.inlineContent) {
      updateLoroMapChildren(data, pm, mapping);
    } else {
      if (hasInline(data)) data.delete(CHILDREN_KEY);
      place(t, blockChildren(pm));
    }
    mapping.set(data.id, pm);
    WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(pm, data.id);
  };

  const place = (parent: LoroTreeNode | undefined, pms: Node[]) => {
    placed.push(parent);
    const kids = childrenOf(tree, parent);
    pms.forEach((pm, i) => {
      const here = kids[i];
      // Unchanged since the last sync (remote changes clear the cache).
      if (here && !used.has(here.id) && mapping.get(here.data.id) === pm) {
        used.add(here.id);
        return;
      }
      const bid = typeof pm.attrs.bid === "string" && pm.attrs.bid ? (pm.attrs.bid as string) : null;
      let node: LoroTreeNode | undefined;
      if (here && !used.has(here.id) && (bid ? bidOf(here) === bid : !bidOf(here) && nameOf(here) === pm.type.name)) {
        node = here;
      } else if (bid) {
        node = findBid(bid);
        if (node && (used.has(node.id) || node.isDeleted())) node = undefined;
      } else {
        node = kids.find((c) => !used.has(c.id) && !bidOf(c) && nameOf(c) === pm.type.name);
      }
      if (node) {
        if (node.id !== here?.id) {
          tree.move(node.id, parent?.id, i);
          const at = kids.findIndex((k) => k.id === node!.id);
          if (at >= 0) kids.splice(at, 1);
          kids.splice(i, 0, node);
        }
      } else {
        node = tree.createNode(parent?.id, i);
        kids.splice(i, 0, node);
        initData(node.data as unknown as LoroNode, pm, mapping);
      }
      used.add(node.id);
      syncNode(node, pm);
    });
  };

  place(undefined, blockChildren(pmDoc));

  // Under the parents that were placed, the nodes no block used (their
  // used descendants were moved out first).
  for (const parent of placed) {
    if (parent && (parent.isDeleted() || !used.has(parent.id))) continue;
    for (const n of childrenOf(tree, parent)) {
      if (used.has(n.id)) continue;
      mapping.delete(n.data.id);
      tree.delete(n.id);
    }
  }
}

/** Writes the editor state's document into the tree and commits. */
export function updateLoroToPmState(
  doc: LoroDoc,
  mapping: LoroNodeMapping,
  editorState: { doc: Node },
  _containerId?: ContainerID,
  origin = LORO_SYNC_ORIGIN,
) {
  syncTreeFromPm(doc, editorState.doc, mapping);
  doc.commit({ origin });
}

// ---- events ----

/** Drops the cached ProseMirror nodes that an event batch changed: the
 *  changed containers and every block above them. A change to the tree's
 *  structure drops every block (texts stay cached). */
export function clearChangedTreeNodes(doc: LoroDoc, event: LoroEventBatch, mapping: LoroNodeMapping) {
  const tree = bodyTree(doc);
  for (const e of event.events) {
    if (e.target === tree.id) {
      for (const [id, value] of mapping) if (!Array.isArray(value)) mapping.delete(id);
      continue;
    }
    let obj = doc.getContainerById(e.target) as { id: ContainerID; parent(): unknown } | undefined;
    while (obj) {
      mapping.delete(obj.id);
      const treeId = treeIdOfData(obj.id);
      if (treeId) {
        let node = tree.getNodeByID(treeId);
        while (node && !node.isDeleted()) {
          mapping.delete(node.data.id);
          node = node.parent();
        }
        break;
      }
      obj = obj.parent() as typeof obj;
    }
  }
}

// ---- positions ----

/** The ProseMirror position `index` within the block whose data map is
 *  `dataId` becomes, counted from the document start: the sizes of the
 *  blocks before it at each level, plus one per level entered. Null for a
 *  deleted block (an undo removed the line the cursor was on): it has no
 *  place, and Loro throws on asking a deleted node for its parent. */
export function treePosition(doc: LoroDoc, dataId: ContainerID, index: number, mapping: LoroNodeMapping): number | null {
  const tree = bodyTree(doc);
  const id = treeIdOfData(dataId);
  let node = id ? tree.getNodeByID(id) : undefined;
  if (node?.isDeleted()) return null;
  while (node) {
    const parent = node.parent();
    for (const sib of childrenOf(tree, parent)) {
      if (sib.id === node.id) break;
      const mapped = mapping.get(sib.data.id);
      if (mapped && !Array.isArray(mapped)) index += mapped.nodeSize;
    }
    index += 1;
    node = parent;
  }
  return index;
}
