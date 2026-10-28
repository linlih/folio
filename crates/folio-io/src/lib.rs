//! Import and export (design/ARCHITECTURE.md §5.5). M2: Markdown export.
//! Later: the Markdown mirror, Logseq import, JSON Canvas (M6).

pub mod markdown;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use loro::LoroDoc;
pub use markdown::{body_markdown, link_target, Links};

/// A card to export: its id, title, its date when it is a journal day, and
/// its document.
pub struct ExportCard {
    pub id: String,
    pub title: String,
    pub journal_date: Option<String>,
    pub doc: LoroDoc,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct ExportSummary {
    pub cards: usize,
    pub journals: usize,
    /// Images and attachments copied into `assets/`.
    pub files: usize,
}

/// Copies the files that exported cards use into one folder, once each,
/// under their own names (made unique, case-insensitively), and gives the
/// link to write for each. Files this device does not have are linked by
/// name and not copied.
pub struct FileCopies<'a> {
    dir: PathBuf,
    /// What links start with: the folder as seen from the Markdown files.
    prefix: String,
    source: &'a dyn Fn(&str) -> Option<PathBuf>,
    names: RefCell<HashMap<String, String>>,
    taken: RefCell<HashSet<String>>,
    error: RefCell<Option<std::io::Error>>,
}

impl<'a> FileCopies<'a> {
    pub fn new(dir: PathBuf, prefix: &str, source: &'a dyn Fn(&str) -> Option<PathBuf>) -> Self {
        FileCopies { dir, prefix: prefix.to_owned(), source, names: Default::default(), taken: Default::default(), error: RefCell::new(None) }
    }

    /// The link for a file (hash, name), copying it on first use.
    pub fn link(&self, sha256: &str, name: &str) -> Option<String> {
        if let Some(n) = self.names.borrow().get(sha256) {
            return Some(link_target(&format!("{}{n}", self.prefix)));
        }
        let from = (self.source)(sha256)?;
        let base = file_stem(name);
        let base = if base.is_empty() { sha256[..12].to_owned() } else { base };
        let (stem, ext) = match base.rsplit_once('.') {
            Some((s, e)) if !s.is_empty() => (s.to_owned(), format!(".{e}")),
            _ => (base.clone(), String::new()),
        };
        let mut file = base.clone();
        let mut n = 2;
        while !self.taken.borrow_mut().insert(file.to_lowercase()) {
            file = format!("{stem} ({n}){ext}");
            n += 1;
        }
        let copied = std::fs::create_dir_all(&self.dir).and_then(|_| std::fs::copy(&from, self.dir.join(&file)));
        if let Err(e) = copied {
            self.error.borrow_mut().get_or_insert(e);
            return None;
        }
        self.names.borrow_mut().insert(sha256.to_owned(), file.clone());
        Some(link_target(&format!("{}{file}", self.prefix)))
    }

    /// How many files were copied, or the first copy that failed.
    pub fn finish(self) -> std::io::Result<usize> {
        match self.error.into_inner() {
            Some(e) => Err(e),
            None => Ok(self.names.into_inner().len()),
        }
    }
}

/// A title as a file name: characters that file systems reserve become `-`.
pub fn file_stem(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '-' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let short: String = trimmed.chars().take(120).collect();
    short.trim().to_owned()
}

/// File names for every card, unique within the export (case-insensitively,
/// for macOS and Windows): `journals/<date>.md`, `cards/<title>.md`, with
/// " (2)" and so on for repeated titles. Returns id → (folder, stem).
fn names(cards: &[ExportCard], untitled: &str) -> HashMap<String, (&'static str, String)> {
    let mut taken = HashSet::new();
    let mut out = HashMap::new();
    for card in cards {
        let (folder, base) = match &card.journal_date {
            Some(date) => ("journals", date.clone()),
            None => {
                let stem = file_stem(&card.title);
                ("cards", if stem.is_empty() { untitled.to_owned() } else { stem })
            }
        };
        let mut stem = base.clone();
        let mut n = 2;
        while !taken.insert(format!("{folder}/{}", stem.to_lowercase())) {
            stem = format!("{base} ({n})");
            n += 1;
        }
        out.insert(card.id.clone(), (folder, stem));
    }
    out
}

/// Writes every card as Markdown under `dir` (`cards/`, `journals/`), and
/// the images and attachments they use under `assets/`. Card links become
/// `[[file name]]`, so Obsidian and Logseq resolve them; block references
/// show the referenced block's text.
pub fn export_markdown(
    dir: &Path,
    cards: &[ExportCard],
    block_text: &dyn Fn(&str) -> Option<String>,
    asset_file: &dyn Fn(&str) -> Option<PathBuf>,
    untitled: &str,
) -> std::io::Result<ExportSummary> {
    let names = names(cards, untitled);
    let card_title = |id: &str| names.get(id).map(|(_, stem)| stem.clone());
    let copies = FileCopies::new(dir.join("assets"), "../assets/", asset_file);
    let file = |sha256: &str, name: &str| copies.link(sha256, name);
    let links = Links { card_title: &card_title, block_text, file: &file };
    let mut summary = ExportSummary::default();
    for folder in ["cards", "journals"] {
        std::fs::create_dir_all(dir.join(folder))?;
    }
    for card in cards {
        let (folder, stem) = &names[&card.id];
        let body = body_markdown(&card.doc, &links);
        let path: PathBuf = dir.join(folder).join(format!("{stem}.md"));
        std::fs::write(path, body)?;
        if card.journal_date.is_some() {
            summary.journals += 1;
        } else {
            summary.cards += 1;
        }
    }
    summary.files = copies.finish()?;
    Ok(summary)
}

#[cfg(test)]
mod tests;
