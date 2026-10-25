use std::borrow::Cow;

use anyhow::{Result, anyhow};
use loro::{
    Container, ExportMode, LoroDoc, LoroList, LoroMap, LoroText, LoroValue, ValueOrContainer,
    VersionVector,
};
use serde_json::{Map, Value};

use crate::{DocEngine, ImportBlock, canonical};

// Layout written by loro-prosemirror (src/lib.ts): root map "doc" holding
// {nodeName, attributes: Map, children: List<Map | Text>}.
const ROOT: &str = "doc";
const NODE_NAME: &str = "nodeName";
const ATTRS: &str = "attributes";
const CHILDREN: &str = "children";

pub struct LoroEngine {
    pub doc: LoroDoc,
}

fn value_json(v: &LoroValue) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

fn node_canonical(map: &LoroMap) -> Value {
    let name = match map.get(NODE_NAME) {
        Some(ValueOrContainer::Value(LoroValue::String(s))) => s.to_string(),
        _ => "?".into(),
    };
    let mut attrs = Map::new();
    if let Some(ValueOrContainer::Container(Container::Map(a))) = map.get(ATTRS) {
        if let LoroValue::Map(m) = a.get_deep_value() {
            for (k, v) in m.iter() {
                attrs.insert(k.to_string(), value_json(v));
            }
        }
    }
    let mut content = Vec::new();
    if let Some(ValueOrContainer::Container(Container::List(list))) = map.get(CHILDREN) {
        for i in 0..list.len() {
            match list.get(i) {
                Some(ValueOrContainer::Container(Container::Map(child))) => content.push(node_canonical(&child)),
                Some(ValueOrContainer::Container(Container::Text(t))) => content.extend(text_canonical(&t)),
                _ => {}
            }
        }
    }
    canonical::element(&name, attrs, content)
}

fn text_canonical(t: &LoroText) -> Vec<Value> {
    t.to_delta()
        .into_iter()
        .filter_map(|d| match d {
            loro::TextDelta::Insert { insert, attributes } => {
                let marks = attributes
                    .map(|a| a.into_iter().filter(|(_, v)| !v.is_null()).map(|(k, _)| k).collect())
                    .unwrap_or_default();
                Some(canonical::text(&insert, marks))
            }
            _ => None,
        })
        .collect()
}

impl LoroEngine {
    fn board_map(&self, name: &str) -> LoroMap {
        self.doc.get_map(name)
    }
}

impl DocEngine for LoroEngine {
    const NAME: &'static str = "loro";

    fn new(peer: u64) -> Self {
        let doc = LoroDoc::new();
        doc.set_peer_id(peer).unwrap();
        LoroEngine { doc }
    }

    fn load(bytes: &[u8], peer: u64) -> Result<Self> {
        let e = Self::new(peer);
        e.doc.import(bytes).map_err(|err| anyhow!("loro import: {err}"))?;
        Ok(e)
    }

    fn apply_update(&self, update: &[u8]) -> Result<()> {
        self.doc.import(update).map_err(|err| anyhow!("loro import: {err}"))?;
        Ok(())
    }

    fn version(&self) -> Vec<u8> {
        self.doc.oplog_vv().encode()
    }

    fn export_since(&self, version: &[u8]) -> Result<Vec<u8>> {
        let vv = VersionVector::decode(version).map_err(|e| anyhow!("vv: {e}"))?;
        self.doc
            .export(ExportMode::Updates { from: Cow::Owned(vv) })
            .map_err(|e| anyhow!("export: {e}"))
    }

    fn snapshot(&self) -> Vec<u8> {
        self.doc.export(ExportMode::Snapshot).unwrap()
    }

    fn compact(&self) -> Vec<u8> {
        let f = self.doc.oplog_frontiers();
        self.doc.export(ExportMode::shallow_snapshot(&f)).unwrap()
    }

    fn card_canonical(&self) -> Value {
        let root = self.doc.get_map(ROOT);
        if root.is_empty() {
            return Value::Null;
        }
        node_canonical(&root)
    }

    fn board_canonical(&self) -> Value {
        let items = self.board_map("items").get_deep_value();
        let edges = self.board_map("edges").get_deep_value();
        serde_json::json!({ "items": value_json(&items), "edges": value_json(&edges) })
    }

    fn board_put_item(&self, id: &str, card: &str, x: f64, y: f64, w: f64, h: f64) {
        let item = self.board_map("items").insert_container(id, LoroMap::new()).unwrap();
        item.insert("card", card).unwrap();
        item.insert("x", x).unwrap();
        item.insert("y", y).unwrap();
        item.insert("w", w).unwrap();
        item.insert("h", h).unwrap();
        self.doc.commit();
    }

    fn board_move_item(&self, id: &str, x: f64, y: f64) {
        if let Some(ValueOrContainer::Container(Container::Map(item))) = self.board_map("items").get(id) {
            item.insert("x", x).unwrap();
            item.insert("y", y).unwrap();
            self.doc.commit();
        }
    }

    fn board_remove_item(&self, id: &str) {
        let items = self.board_map("items");
        if items.get(id).is_some() {
            items.delete(id).unwrap();
            self.doc.commit();
        }
    }

    fn board_put_edge(&self, id: &str, from: &str, to: &str) {
        let edge = self.board_map("edges").insert_container(id, LoroMap::new()).unwrap();
        edge.insert("from", from).unwrap();
        edge.insert("to", to).unwrap();
        self.doc.commit();
    }

    fn board_remove_edge(&self, id: &str) {
        let edges = self.board_map("edges");
        if edges.get(id).is_some() {
            edges.delete(id).unwrap();
            self.doc.commit();
        }
    }

    // Mirrors loro-prosemirror, which creates `attributes`/`children` with
    // getOrCreateContainer; only the creating peer ever does that for a node.
    #[allow(deprecated)]
    fn card_append_blocks(&self, blocks: &[ImportBlock]) {
        let root = self.doc.get_map(ROOT);
        if root.is_empty() {
            root.insert(NODE_NAME, "doc").unwrap();
            root.get_or_create_container(ATTRS, LoroMap::new()).unwrap();
        }
        let children = root.get_or_create_container(CHILDREN, LoroList::new()).unwrap();
        for b in blocks {
            let node = children.insert_container(children.len(), LoroMap::new()).unwrap();
            node.insert(NODE_NAME, b.node).unwrap();
            let attrs = node.get_or_create_container(ATTRS, LoroMap::new()).unwrap();
            attrs.insert("bid", b.bid).unwrap();
            if b.node == "heading" {
                attrs.insert("level", 2).unwrap();
            }
            let kids = node.get_or_create_container(CHILDREN, LoroList::new()).unwrap();
            let text = kids.insert_container(0, LoroText::new()).unwrap();
            text.insert(0, b.text).unwrap();
        }
        self.doc.commit();
    }
}
