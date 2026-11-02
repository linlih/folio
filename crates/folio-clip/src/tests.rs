use super::*;

#[test]
fn reads_open_graph_first_then_twitter_then_plain() {
    let page = r#"<html><head><title>Page &amp; title</title>
      <meta name="description" content="plain description">
      <meta name="twitter:title" content="Twitter title" />
      <meta property="og:title" content="GitHub - loro-dev/loro: CRDTs &#x1F600;">
      <meta property="og:site_name" content='GitHub'>
      </head><body><meta property="og:title" content="later one"></body></html>"#;
    let p = parse_page(page);
    assert_eq!(p.title, "GitHub - loro-dev/loro: CRDTs 😀");
    assert_eq!(p.excerpt, "plain description");
    assert_eq!(p.site, "GitHub");
    let p = finish(p, "github.com");
    assert_eq!(p.title, "loro-dev/loro: CRDTs 😀");
}

#[test]
fn falls_back_to_the_page_title() {
    let p = finish(parse_page("<TITLE>\n  Just a  title\n</TITLE>"), "example.org");
    assert_eq!(p.title, "Just a title");
    assert_eq!(p.site, "example.org");
    assert_eq!(p.excerpt, "");
}

#[test]
fn a_wechat_article_names_its_account() {
    let page = r#"<meta property="og:title" content="一篇文章" />
      <meta property="og:description" content="文章的摘要&hellip;" />
      <meta property="og:site_name" content="微信公众平台" />
      <script>var nickname = htmlDecode("某个公众号");</script>"#;
    let p = finish(parse_page(page), "mp.weixin.qq.com");
    assert_eq!((p.title.as_str(), p.site.as_str(), p.author.as_str(), p.excerpt.as_str()), ("一篇文章", "微信公众号", "某个公众号", "文章的摘要…"));
}

#[test]
fn x_posts_come_from_the_embed_paragraph() {
    let o = OEmbed {
        title: String::new(),
        author_name: "jack".into(),
        html: "<blockquote class=\"twitter-tweet\"><p lang=\"en\" dir=\"ltr\">just setting up my <a href=\"x\">twttr</a> &amp; more</p>&mdash; jack</blockquote>".into(),
        provider_name: "X".into(),
    };
    let p = finish(from_oembed(o), "x.com");
    assert_eq!(p.title, "just setting up my twttr & more");
    assert_eq!(p.excerpt, "just setting up my twttr & more");
    assert_eq!(p.author, "jack");
    let reddit = OEmbed { title: "A post".into(), author_name: "someone".into(), html: "<blockquote><a>A post</a></blockquote>".into(), provider_name: "reddit".into() };
    let p = finish(from_oembed(reddit), "reddit.com");
    assert_eq!((p.title.as_str(), p.site.as_str(), p.excerpt.as_str()), ("A post", "Reddit", ""));
}

#[test]
fn x_articles_and_unreachable_posts_take_their_author() {
    // A long-form article: the embed's text is only its t.co link.
    let o = OEmbed {
        title: String::new(),
        author_name: "Leon Lin".into(),
        html: "<blockquote class=\"twitter-tweet\"><p lang=\"zxx\" dir=\"ltr\"><a href=\"https://t.co/eP5cedefS0\">https://t.co/eP5cedefS0</a></p>&mdash; Leon Lin (@LexnLin)</blockquote>".into(),
        provider_name: "X".into(),
    };
    let mut p = from_oembed(o);
    p.url = "https://x.com/LexnLin/status/2116662591363690999?a=L_Jt4&s=09".into();
    let p = finish(p, "x.com");
    assert_eq!((p.title.as_str(), p.excerpt.as_str(), p.author.as_str()), ("Leon Lin (@LexnLin)", "", "Leon Lin"));
    // X not reachable from this device: the account in the link.
    let p = fallback("https://x.com/LexnLin/status/2116662591363690999?s=09");
    assert_eq!((p.title.as_str(), p.site.as_str(), p.author.as_str()), ("@LexnLin", "X", "@LexnLin"));
    assert_eq!(fallback("https://twitter.com/jack/status/20").title, "@jack");
    // A link with no account keeps the host.
    assert_eq!(fallback("https://x.com/i/article/2116604278412394496").title, "x.com");
}

#[test]
fn x_embed_gives_an_articles_title() {
    assert_eq!(x_status_id("https://x.com/LexnLin/status/2116662591363690999?a=L_Jt4&s=09").as_deref(), Some("2116662591363690999"));
    assert_eq!(x_status_id("https://twitter.com/jack/statuses/20").as_deref(), Some("20"));
    assert_eq!(x_status_id("https://x.com/LexnLin"), None);
    // As X's embed script computes it.
    assert_eq!(x_embed_token("2116662591363690999"), "54powdhmpx");
    assert_eq!(x_embed_token("20"), "6dq1a2xwd93");
    assert_eq!(x_embed_token("1585341984679469056"), "3uchycv2wqc");

    let article: XPost = serde_json::from_str(r#"{"text":"https://t.co/eP5cedefS0","display_text_range":[0,23],"user":{"name":"Leon Lin"},
        "article":{"title":"How I prompt AI to build good looking demos","preview_text":"Under every demo people ask me for the prompt."}}"#).unwrap();
    let p = finish(from_x_post(article), "x.com");
    assert_eq!(p.title, "How I prompt AI to build good looking demos");
    assert_eq!(p.excerpt, "Under every demo people ask me for the prompt.");
    assert_eq!((p.site.as_str(), p.author.as_str()), ("X", "Leon Lin"));

    // A post: its words, not the link to its picture after them.
    let post: XPost = serde_json::from_str(r#"{"text":"看这张图 &amp; 说明 https://t.co/abc","display_text_range":[0,13],"user":{"name":"某人"}}"#).unwrap();
    let p = finish(from_x_post(post), "x.com");
    assert_eq!((p.title.as_str(), p.excerpt.as_str()), ("看这张图 & 说明", "看这张图 & 说明"));
}

#[test]
fn long_summaries_are_cut() {
    let long = "字".repeat(EXCERPT_CHARS + 50);
    let p = finish(LinkPreview { title: "t".into(), excerpt: long, ..Default::default() }, "a.com");
    assert_eq!(p.excerpt.chars().count(), EXCERPT_CHARS);
    assert!(p.excerpt.ends_with('…'));
}

#[test]
fn hosts_and_bare_links() {
    assert_eq!(host("https://www.GitHub.com/a/b?c#d").as_deref(), Some("github.com"));
    assert_eq!(host("http://user@example.org:8080").as_deref(), Some("example.org"));
    assert_eq!(host("ftp://x"), None);
    assert_eq!(host("https://"), None);
    let p = fallback(" https://mp.weixin.qq.com/s/abc ");
    assert_eq!((p.url.as_str(), p.title.as_str(), p.site.as_str()), ("https://mp.weixin.qq.com/s/abc", "mp.weixin.qq.com", "微信公众号"));
    assert!(matches!(fetch("not a link"), Err(ClipError::NotALink)));
}

#[test]
fn attributes_and_entities() {
    assert_eq!(decode_entities("a &amp;&lt;b&gt; &#20013; &unknown; &"), "a &<b> 中 &unknown; &");
    let p = parse_page("<meta content=\"x\" data-name=\"og:title\"><meta name=description content=unquoted>");
    assert_eq!(p.title, "");
    assert_eq!(p.excerpt, "unquoted");
}

/// Reads real pages; needs the network. `cargo test -p folio-clip -- --ignored`
#[test]
#[ignore]
fn live_pages() {
    let p = fetch("https://github.com/loro-dev/loro").unwrap();
    assert!(p.title.starts_with("loro-dev/loro"), "{p:?}");
    assert!(!p.excerpt.is_empty());
    let p = fetch("https://x.com/jack/status/20").unwrap();
    assert_eq!(p.excerpt, "just setting up my twttr", "{p:?}");
    let p = fetch("https://x.com/LexnLin/status/2116662591363690999?a=L_Jt4-UMmx9a573hybE&s=09").unwrap();
    assert_eq!(p.title, "How I prompt AI to build good looking demos", "{p:?}");
    let p = fetch("https://www.reddit.com/r/rust/comments/1d2l8k2/").unwrap();
    assert!(!p.title.is_empty() && p.site == "Reddit", "{p:?}");
}
