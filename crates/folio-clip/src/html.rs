//! Just enough HTML reading for a page's description of itself: `<meta>`
//! tags, `<title>`, and a WeChat article's account name. Not a parser:
//! anything it cannot make out is left empty.

use crate::LinkPreview;

/// The preview a page gives of itself. The first of each kind of tag wins,
/// in the order Open Graph, Twitter card, plain `<meta>`.
pub fn parse_page(html: &str) -> LinkPreview {
    let mut og = Meta::default();
    let mut tw = Meta::default();
    let mut plain = Meta::default();
    let mut site = String::new();
    let lower = html.to_ascii_lowercase();
    let mut at = 0;
    while let Some(i) = lower[at..].find("<meta") {
        let start = at + i;
        let Some(len) = lower[start..].find('>') else { break };
        let tag = &html[start..start + len];
        at = start + len;
        let key = attr(tag, "property").or_else(|| attr(tag, "name")).unwrap_or_default().to_ascii_lowercase();
        let Some(value) = attr(tag, "content").map(|v| decode_entities(&v)) else { continue };
        if value.trim().is_empty() {
            continue;
        }
        let set = |slot: &mut String| {
            if slot.is_empty() {
                *slot = value.clone();
            }
        };
        match key.as_str() {
            "og:title" => set(&mut og.title),
            "og:description" => set(&mut og.description),
            "og:site_name" => set(&mut site),
            "og:article:author" | "article:author" => set(&mut og.author),
            "twitter:title" => set(&mut tw.title),
            "twitter:description" => set(&mut tw.description),
            "description" => set(&mut plain.description),
            "author" => set(&mut plain.author),
            _ => {}
        }
    }
    let title = [og.title, tw.title, page_title(html, &lower)].into_iter().find(|s| !s.trim().is_empty()).unwrap_or_default();
    let excerpt = [og.description, tw.description, plain.description].into_iter().find(|s| !s.trim().is_empty()).unwrap_or_default();
    // A WeChat article names its account in a script, not a tag.
    let author = [wechat_account(html), og.author, plain.author].into_iter().find(|s| !s.trim().is_empty()).unwrap_or_default();
    LinkPreview { url: String::new(), title, site, excerpt, author }
}

#[derive(Default)]
struct Meta {
    title: String,
    description: String,
    author: String,
}

fn page_title(html: &str, lower: &str) -> String {
    let Some(i) = lower.find("<title") else { return String::new() };
    let Some(open) = lower[i..].find('>') else { return String::new() };
    let from = i + open + 1;
    let Some(len) = lower[from..].find("</title") else { return String::new() };
    decode_entities(&html[from..from + len])
}

/// `var nickname = htmlDecode("名字");` or `var nickname = "名字";`
fn wechat_account(html: &str) -> String {
    let Some(i) = html.find("var nickname") else { return String::new() };
    let rest = &html[i..html.len().min(i + 400)];
    let Some(q) = rest.find(['"', '\'']) else { return String::new() };
    let quote = rest[q..].chars().next().unwrap();
    let body = &rest[q + 1..];
    let Some(end) = body.find(quote) else { return String::new() };
    decode_entities(&body[..end])
}

/// An attribute's value inside a tag's text, quoted or not.
fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let start = from + i;
        from = start + name.len();
        // A whole attribute name: not the end of a longer one.
        if start > 0 && !lower.as_bytes()[start - 1].is_ascii_whitespace() {
            continue;
        }
        let rest = tag[from..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else { continue };
        let rest = rest.trim_start();
        return Some(match rest.chars().next() {
            Some(q @ ('"' | '\'')) => rest[1..].split(q).next().unwrap_or("").to_owned(),
            _ => rest.split(|c: char| c.is_whitespace() || c == '/' || c == '>').next().unwrap_or("").to_owned(),
        });
    }
    None
}

/// Removes tags, keeping the text between them.
pub fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for c in s.chars() {
        match c {
            '<' => inside = true,
            '>' if inside => inside = false,
            _ if !inside => out.push(c),
            _ => {}
        }
    }
    out
}

/// Character references: numeric ones and the named ones pages use in titles.
pub fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest[..rest.len().min(12)].find(';');
        let decoded = end.and_then(|end| {
            let name = &rest[1..end];
            let c = if let Some(hex) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
            } else if let Some(dec) = name.strip_prefix('#') {
                dec.parse().ok().and_then(char::from_u32)
            } else {
                named(name)
            }?;
            Some((c, end + 1))
        });
        match decoded {
            Some((c, len)) => {
                out.push(c);
                rest = &rest[len..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn named(name: &str) -> Option<char> {
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        "mdash" => '—',
        "ndash" => '–',
        "hellip" => '…',
        "middot" => '·',
        "laquo" => '«',
        "raquo" => '»',
        "lsquo" => '‘',
        "rsquo" => '’',
        "ldquo" => '“',
        "rdquo" => '”',
        "copy" => '©',
        _ => return None,
    })
}
