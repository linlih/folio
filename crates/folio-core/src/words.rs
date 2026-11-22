//! Word count (design/stats.md §2.1): each Chinese, Japanese or Korean
//! character counts one; a run of other letters and digits counts one word,
//! with `'`, `’`, `-` and `.` inside it not breaking it. Punctuation,
//! whitespace and emoji do not count. `web/src/docs/words.ts` is the same
//! rule; both run the cases in `word_count_cases.json`.

/// Han, kana and hangul, by code point (the same ranges as words.ts).
pub fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x11FF | 0x2E80..=0x2FDF | 0x3005 | 0x3007 | 0x3021..=0x3029 | 0x3038..=0x303B
        | 0x3040..=0x309F | 0x30A0..=0x30FF | 0x3130..=0x318F | 0x31F0..=0x31FF | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF | 0xA960..=0xA97F | 0xAC00..=0xD7AF | 0xD7B0..=0xD7FF | 0xF900..=0xFAFF
        | 0xFF66..=0xFF9D | 0x20000..=0x323AF)
}

fn is_word_char(c: char) -> bool {
    !is_cjk(c) && (c.is_alphabetic() || c.is_numeric())
}

pub fn count_words(text: &str) -> usize {
    let chars: Vec<char> = text.chars().collect();
    let mut count = 0;
    let mut in_word = false;
    for (i, &c) in chars.iter().enumerate() {
        if is_cjk(c) {
            count += 1;
            in_word = false;
        } else if is_word_char(c) {
            if !in_word {
                count += 1;
                in_word = true;
            }
        } else if in_word && matches!(c, '\'' | '’' | '-' | '.') && chars.get(i + 1).is_some_and(|&n| is_word_char(n)) {
            // Inside a word: don't, e-mail, 3.14.
        } else {
            in_word = false;
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::count_words;

    #[test]
    fn shared_cases() {
        let cases: Vec<(String, usize)> = serde_json::from_str(include_str!("word_count_cases.json")).unwrap();
        for (text, want) in cases {
            assert_eq!(count_words(&text), want, "{text:?}");
        }
    }
}
