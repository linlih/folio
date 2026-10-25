//! Import and export (design/ARCHITECTURE.md §5.5). M2: Markdown export.
//! Later: the Markdown mirror, Logseq import, JSON Canvas (M6).

pub mod markdown;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use loro::LoroDoc;
pub use markdown::{body_markdown, Links};

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

/// Writes every card as Markdown under `dir` (`cards/`, `journals/`).
/// Card links become `[[file name]]`, so Obsidian and Logseq resolve them;
/// block references show the referenced block's text.
pub fn export_markdown(
    dir: &Path,
    cards: &[ExportCard],
    block_text: &dyn Fn(&str) -> Option<String>,
    untitled: &str,
) -> std::io::Result<ExportSummary> {
    let names = names(cards, untitled);
    let card_title = |id: &str| names.get(id).map(|(_, stem)| stem.clone());
    let links = Links { card_title: &card_title, block_text };
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
    Ok(summary)
}

#[cfg(test)]
mod tests;
