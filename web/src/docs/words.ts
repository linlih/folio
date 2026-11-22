// Word count (design/stats.md §2.1): each Chinese, Japanese or Korean
// character counts one; a run of other letters and digits counts one word,
// with ' ’ - . inside it not breaking it. Punctuation, whitespace and emoji
// do not count. crates/folio-core/src/words.rs is the same rule; both run the
// cases in crates/folio-core/src/word_count_cases.json.

const CJK: [number, number][] = [
  [0x1100, 0x11ff], [0x2e80, 0x2fdf], [0x3005, 0x3005], [0x3007, 0x3007], [0x3021, 0x3029], [0x3038, 0x303b],
  [0x3040, 0x309f], [0x30a0, 0x30ff], [0x3130, 0x318f], [0x31f0, 0x31ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa960, 0xa97f], [0xac00, 0xd7af], [0xd7b0, 0xd7ff], [0xf900, 0xfaff],
  [0xff66, 0xff9d], [0x20000, 0x323af],
];

export function isCjk(c: string): boolean {
  const n = c.codePointAt(0)!;
  return CJK.some(([a, b]) => n >= a && n <= b);
}

/** Rust's char::is_alphabetic() || is_numeric(). */
const WORD = /[\p{Alphabetic}\p{N}]/u;
const isWordChar = (c: string) => !isCjk(c) && WORD.test(c);
const JOINERS = new Set(["'", "’", "-", "."]);

export function countWords(text: string): number {
  const chars = [...text];
  let count = 0;
  let inWord = false;
  chars.forEach((c, i) => {
    if (isCjk(c)) {
      count++;
      inWord = false;
    } else if (isWordChar(c)) {
      if (!inWord) count++;
      inWord = true;
    } else if (!(inWord && JOINERS.has(c) && i + 1 < chars.length && isWordChar(chars[i + 1]))) {
      inWord = false;
    }
  });
  return count;
}
