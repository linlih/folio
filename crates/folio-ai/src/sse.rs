//! Server-sent events, as both protocols stream: `data:` lines, an event
//! ending at a blank line.

use std::io::BufRead;

use crate::{AiError, Result};

/// Calls `on` with each event's data until the stream ends, `on` returns
/// false, or `cancelled` says so (then returns Ok(false)).
pub fn each(mut reader: impl BufRead, cancelled: &dyn Fn() -> bool, mut on: impl FnMut(&str) -> Result<bool>) -> Result<bool> {
    let mut data = String::new();
    let mut line = String::new();
    loop {
        if cancelled() {
            return Ok(false);
        }
        line.clear();
        let n = reader.read_line(&mut line).map_err(|e| AiError::Network(e.to_string()))?;
        let text = line.trim_end_matches(['\r', '\n']);
        if n == 0 || text.is_empty() {
            if !data.is_empty() && !on(&data)? {
                return Ok(true);
            }
            data.clear();
            if n == 0 {
                return Ok(true);
            }
            continue;
        }
        if let Some(rest) = text.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        }
        // `event:`, `id:` and comments: the data says what it is.
    }
}
