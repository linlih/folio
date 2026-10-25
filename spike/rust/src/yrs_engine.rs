use anyhow::{Result, anyhow};
use serde_json::{Map, Value};
use yrs::types::ToJson;
use yrs::types::text::YChange;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    Any, Doc, GetString, In, Map as _, MapPrelim, MapRef, Options, Out, ReadTxn, StateVector, Text,
    Transact, Update, Xml, XmlElementPrelim, XmlElementRef, XmlFragment, XmlFragmentRef, XmlOut,
    XmlTextPrelim, XmlTextRef,
};

use crate::{DocEngine, ImportBlock, canonical};

// y-prosemirror stores the document as the children of this XmlFragment.
const FRAGMENT: &str = "prosemirror";

pub struct YrsEngine {
    pub doc: Doc,
}

fn any_json(a: &Any) -> Value {
    serde_json::to_value(a).unwrap_or(Value::Null)
}

fn out_json<T: ReadTxn>(o: &Out, txn: &T) -> Value {
    match o {
        Out::Any(a) => any_json(a),
        Out::YText(t) => Value::String(t.get_string(txn)),
        _ => Value::Null,
    }
}

fn children_canonical<T: ReadTxn, F: XmlFragment>(f: &F, txn: &T) -> Vec<Value> {
    let mut out = Vec::new();
    for i in 0..f.len(txn) {
        match f.get(txn, i) {
            Some(XmlOut::Element(e)) => out.push(element_canonical(&e, txn)),
            Some(XmlOut::Text(t)) => out.extend(text_canonical(&t, txn)),
            _ => {}
        }
    }
    out
}

fn element_canonical<T: ReadTxn>(e: &XmlElementRef, txn: &T) -> Value {
    let mut attrs = Map::new();
    for (k, v) in e.attributes(txn) {
        attrs.insert(k.to_string(), out_json(&v, txn));
    }
    canonical::element(e.tag(), attrs, children_canonical(e, txn))
}

fn text_canonical<T: ReadTxn>(t: &XmlTextRef, txn: &T) -> Vec<Value> {
    t.diff(txn, YChange::identity)
        .into_iter()
        .filter_map(|d| {
            let s = match &d.insert {
                Out::Any(Any::String(s)) => s.to_string(),
                _ => return None,
            };
            let marks = d
                .attributes
                .map(|a| a.iter().filter(|(_, v)| **v != Any::Null).map(|(k, _)| k.to_string()).collect())
                .unwrap_or_default();
            Some(canonical::text(&s, marks))
        })
        .collect()
}

impl YrsEngine {
    fn map(&self, name: &str) -> MapRef {
        self.doc.get_or_insert_map(name)
    }

    fn fragment(&self) -> XmlFragmentRef {
        self.doc.get_or_insert_xml_fragment(FRAGMENT)
    }
}

impl DocEngine for YrsEngine {
    const NAME: &'static str = "yjs";

    fn new(peer: u64) -> Self {
        let doc = Doc::with_options(Options { client_id: yrs::block::ClientID::new(peer), ..Options::default() });
        YrsEngine { doc }
    }

    fn load(bytes: &[u8], peer: u64) -> Result<Self> {
        let e = Self::new(peer);
        e.apply_update(bytes)?;
        Ok(e)
    }

    fn apply_update(&self, update: &[u8]) -> Result<()> {
        let u = Update::decode_v1(update).map_err(|err| anyhow!("decode: {err}"))?;
        self.doc.transact_mut().apply_update(u).map_err(|err| anyhow!("apply: {err}"))?;
        Ok(())
    }

    fn version(&self) -> Vec<u8> {
        self.doc.transact().state_vector().encode_v1()
    }

    fn export_since(&self, version: &[u8]) -> Result<Vec<u8>> {
        let sv = StateVector::decode_v1(version).map_err(|e| anyhow!("sv: {e}"))?;
        Ok(self.doc.transact().encode_diff_v1(&sv))
    }

    fn snapshot(&self) -> Vec<u8> {
        self.doc.transact().encode_state_as_update_v1(&StateVector::default())
    }

    /// yrs GCs deleted content by default, so the full state is already compact.
    fn compact(&self) -> Vec<u8> {
        self.snapshot()
    }

    fn card_canonical(&self) -> Value {
        let frag = self.fragment();
        let txn = self.doc.transact();
        if frag.len(&txn) == 0 {
            return Value::Null;
        }
        canonical::element("doc", Map::new(), children_canonical(&frag, &txn))
    }

    fn board_canonical(&self) -> Value {
        let (items, edges) = (self.map("items"), self.map("edges"));
        let txn = self.doc.transact();
        serde_json::json!({ "items": any_json(&items.to_json(&txn)), "edges": any_json(&edges.to_json(&txn)) })
    }

    fn board_put_item(&self, id: &str, card: &str, x: f64, y: f64, w: f64, h: f64) {
        let items = self.map("items");
        let mut txn = self.doc.transact_mut();
        let prelim = MapPrelim::from([
            ("card", In::Any(Any::from(card))),
            ("x", In::Any(Any::from(x))),
            ("y", In::Any(Any::from(y))),
            ("w", In::Any(Any::from(w))),
            ("h", In::Any(Any::from(h))),
        ]);
        items.insert(&mut txn, id, prelim);
    }

    fn board_move_item(&self, id: &str, x: f64, y: f64) {
        let items = self.map("items");
        let mut txn = self.doc.transact_mut();
        if let Some(Out::YMap(item)) = items.get(&txn, id) {
            item.insert(&mut txn, "x", x);
            item.insert(&mut txn, "y", y);
        }
    }

    fn board_remove_item(&self, id: &str) {
        let items = self.map("items");
        let mut txn = self.doc.transact_mut();
        items.remove(&mut txn, id);
    }

    fn board_put_edge(&self, id: &str, from: &str, to: &str) {
        let edges = self.map("edges");
        let mut txn = self.doc.transact_mut();
        let prelim = MapPrelim::from([("from", In::Any(Any::from(from))), ("to", In::Any(Any::from(to)))]);
        edges.insert(&mut txn, id, prelim);
    }

    fn board_remove_edge(&self, id: &str) {
        let edges = self.map("edges");
        let mut txn = self.doc.transact_mut();
        edges.remove(&mut txn, id);
    }

    fn card_append_blocks(&self, blocks: &[ImportBlock]) {
        let frag = self.fragment();
        let mut txn = self.doc.transact_mut();
        for b in blocks {
            let idx = frag.len(&txn);
            let el = frag.insert(&mut txn, idx, XmlElementPrelim::empty(b.node));
            el.insert_attribute(&mut txn, "bid", b.bid);
            if b.node == "heading" {
                el.insert_attribute(&mut txn, "level", Any::from(2.0));
            }
            el.push_back(&mut txn, XmlTextPrelim::new(b.text));
        }
    }
}
