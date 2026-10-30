//! What the inbox keeps of a link (design/inbox-and-tags.md §2): its title,
//! site, author and a short summary, never the whole page. Read on this
//! device, straight from the site; nothing goes through the sync server.
//!
//! Most pages describe themselves in `<meta>` tags (Open Graph, Twitter
//! cards, `description`). X and Reddit serve no such page to a program, so
//! their oEmbed endpoints are asked instead.

use std::io::Read;
use std::time::Duration;

use serde::{Deserialize, Serialize};

mod html;

pub use html::{decode_entities, parse_page, strip_tags};

/// The longest summary kept, in characters.
pub const EXCERPT_CHARS: usize = 300;
/// The most of a page read: the `<head>` is near the start.
const PAGE_BYTES: u64 = 2 << 20;
const TIMEOUT: Duration = Duration::from_secs(12);
/// Sites answer a browser more readily than an unknown program.
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    pub url: String,
    pub title: String,
    /// The site's name ("GitHub", "微信公众号"), or its host.
    pub site: String,
    pub excerpt: String,
    pub author: String,
}

#[derive(Debug)]
pub enum ClipError {
    /// Not an http(s) address.
    NotALink,
    /// The site could not be reached or answered with an error.
    Fetch(String),
}

impl std::fmt::Display for ClipError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClipError::NotALink => f.write_str("not a web address"),
            ClipError::Fetch(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ClipError {}

/// The host of an http(s) address, without "www."; None for anything else.
pub fn host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host = authority.rsplit('@').next()?.split(':').next()?.to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    Some(host.strip_prefix("www.").unwrap_or(&host).to_owned())
}

/// What a site is called, for sites people clip from often.
fn known_site(host: &str) -> Option<&'static str> {
    let is = |d: &str| host == d || host.ends_with(&format!(".{d}"));
    Some(match () {
        _ if is("mp.weixin.qq.com") => "微信公众号",
        _ if is("x.com") || is("twitter.com") => "X",
        _ if is("reddit.com") || host == "redd.it" => "Reddit",
        _ if is("github.com") => "GitHub",
        _ if is("youtube.com") || host == "youtu.be" => "YouTube",
        _ if is("zhihu.com") => "知乎",
        _ if is("bilibili.com") || host == "b23.tv" => "哔哩哔哩",
        _ if is("xiaohongshu.com") || host == "xhslink.com" => "小红书",
        _ => return None,
    })
}

/// Reads a link's preview from the web. Fails only when nothing at all was
/// learnt; the caller then keeps the bare link (see [`fallback`]).
pub fn fetch(url: &str) -> Result<LinkPreview, ClipError> {
    let url = url.trim();
    let host = host(url).ok_or(ClipError::NotALink)?;
    let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).redirects(8).user_agent(USER_AGENT).build();
    let mut p = if known_site(&host) == Some("X") {
        oembed(&agent, "https://publish.twitter.com/oembed?omit_script=1&url=", url)?
    } else if known_site(&host) == Some("Reddit") {
        oembed(&agent, "https://www.reddit.com/oembed?url=", url)?
    } else {
        let resp = agent.get(url).call().map_err(|e| ClipError::Fetch(e.to_string()))?;
        let mut bytes = Vec::new();
        resp.into_reader().take(PAGE_BYTES).read_to_end(&mut bytes).map_err(|e| ClipError::Fetch(e.to_string()))?;
        parse_page(&String::from_utf8_lossy(&bytes))
    };
    p.url = url.to_owned();
    Ok(finish(p, &host))
}

/// A link kept as it is, when its page could not be read: the host stands
/// in for the title until someone writes one.
pub fn fallback(url: &str) -> LinkPreview {
    let url = url.trim();
    let host = host(url).unwrap_or_default();
    finish(LinkPreview { url: url.to_owned(), ..Default::default() }, &host)
}

/// Fills the site, trims everything, and keeps the summary short.
fn finish(mut p: LinkPreview, host: &str) -> LinkPreview {
    if let Some(name) = known_site(host) {
        p.site = name.to_owned();
    } else if p.site.trim().is_empty() {
        p.site = host.to_owned();
    }
    p.title = squash(&p.title);
    if p.site == "GitHub" {
        // "GitHub - owner/repo: what it is" → "owner/repo: what it is"
        if let Some(rest) = p.title.strip_prefix("GitHub - ") {
            p.title = rest.to_owned();
        }
    }
    p.site = squash(&p.site);
    p.author = squash(&p.author);
    let excerpt = squash(&p.excerpt);
    p.excerpt = if excerpt == p.title { String::new() } else { cut(&excerpt, EXCERPT_CHARS) };
    if p.title.is_empty() {
        p.title = if p.excerpt.is_empty() { host.to_owned() } else { cut(&p.excerpt, 60) };
    }
    p
}

/// One line, single spaces.
fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn cut(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(n - 1).collect();
    out.push('…');
    out
}

#[derive(Deserialize)]
struct OEmbed {
    #[serde(default)]
    title: String,
    #[serde(default)]
    author_name: String,
    #[serde(default)]
    html: String,
    #[serde(default)]
    provider_name: String,
}

fn oembed(agent: &ureq::Agent, endpoint: &str, url: &str) -> Result<LinkPreview, ClipError> {
    let resp = agent.get(&format!("{endpoint}{}", encode(url))).call().map_err(|e| ClipError::Fetch(e.to_string()))?;
    let o: OEmbed = resp.into_json().map_err(|e| ClipError::Fetch(e.to_string()))?;
    Ok(from_oembed(o))
}

/// A post's text is the paragraph in the embed's HTML (X); a Reddit embed
/// has a title instead.
fn from_oembed(o: OEmbed) -> LinkPreview {
    let text = o.html.find("<p").and_then(|at| {
        let rest = &o.html[at..];
        let open = rest.find('>')? + 1;
        let close = rest.find("</p>")?;
        (open <= close).then(|| decode_entities(&strip_tags(&rest[open..close].replace("<br>", " "))))
    });
    let (title, excerpt) = match (o.title.trim().is_empty(), text) {
        (false, t) => (o.title, t.unwrap_or_default()),
        (true, Some(t)) => (String::new(), t),
        (true, None) => (String::new(), String::new()),
    };
    LinkPreview { url: String::new(), title, site: o.provider_name, excerpt, author: o.author_name }
}

/// Percent-encodes a URL to pass it as a query parameter.
fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests;
