// `osd session find`: the conversations that mention something.
//
// Read straight from the bundled runtime's SQLite store, read-only, as
// `usage.rs` does — asking the runtime for every session's messages would load
// each transcript to search a few words. A conversation matches on its title
// or on any of its words (user or agent); the newest come first, each with the
// line the words were found in.
use std::path::Path;

use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct Found {
    pub id: String,
    pub title: String,
    pub directory: String,
    /// Milliseconds since the epoch.
    pub updated: i64,
    /// Where the words appear: the title, or a line of the conversation.
    pub snippet: String,
}

/// The line of `text` holding `needle` (case-insensitive), shortened around it.
fn snippet(text: &str, needle: &str) -> String {
    let lower = text.to_lowercase();
    let at = lower.find(&needle.to_lowercase()).unwrap_or(0);
    let start = text[..at].rfind('\n').map_or(0, |i| i + 1);
    let end = text[at..].find('\n').map_or(text.len(), |i| at + i);
    let line = text[start..end].trim();
    if line.chars().count() <= 160 {
        return line.to_string();
    }
    let before = text[start..at].chars().count();
    let skip = before.saturating_sub(60);
    let cut: String = line.chars().skip(skip).take(160).collect();
    format!("{}{cut}…", if skip > 0 { "…" } else { "" })
}

/// Conversations (not subagent runs) whose title or words contain `query`.
pub fn find(runtime_root: &Path, query: &str, limit: usize) -> Result<Vec<Found>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("nothing to find".into());
    }
    let db = runtime_root.join("xdg-data").join("opencode").join("opencode.db");
    if !db.exists() {
        return Ok(Vec::new());
    }
    let c = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| e.to_string())?;
    // LIKE is case-insensitive for ASCII; `%` and `_` in the query are literal.
    let pattern = format!("%{}%", query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let mut st = c
        .prepare(
            "SELECT s.id, s.title, s.directory, s.time_updated, \
                    (SELECT json_extract(p.data,'$.text') FROM part p \
                       WHERE p.session_id = s.id AND json_extract(p.data,'$.type') = 'text' \
                         AND json_extract(p.data,'$.text') LIKE ?1 ESCAPE '\\' \
                       ORDER BY p.time_created DESC LIMIT 1) \
             FROM session s \
             WHERE s.parent_id IS NULL \
               AND (s.title LIKE ?1 ESCAPE '\\' OR EXISTS (SELECT 1 FROM part p \
                     WHERE p.session_id = s.id AND json_extract(p.data,'$.type') = 'text' \
                       AND json_extract(p.data,'$.text') LIKE ?1 ESCAPE '\\')) \
             ORDER BY s.time_updated DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map(rusqlite::params![pattern, limit.clamp(1, 200) as i64], |r| {
            let title: String = r.get(1)?;
            let text: Option<String> = r.get(4)?;
            Ok(Found {
                id: r.get(0)?,
                directory: r.get(2)?,
                updated: r.get(3)?,
                snippet: text.map(|t| snippet(&t, query)).unwrap_or_else(|| title.clone()),
                title,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_by_title_and_by_words_newest_first_without_subagents() {
        let root = std::env::temp_dir().join(format!("osd-find-{}", std::process::id()));
        let dir = root.join("xdg-data/opencode");
        std::fs::create_dir_all(&dir).unwrap();
        let c = rusqlite::Connection::open(dir.join("opencode.db")).unwrap();
        c.execute_batch(
            "CREATE TABLE session (id text, parent_id text, title text, directory text, time_updated integer);
             CREATE TABLE part (id text, session_id text, time_created integer, data text);
             INSERT INTO session VALUES ('s1', NULL, 'Fold proteins', '/w/s1', 10);
             INSERT INTO session VALUES ('s2', NULL, 'Plots', '/w/s2', 30);
             INSERT INTO session VALUES ('s3', 's2', 'child', '/w/s2', 40);
             INSERT INTO part VALUES ('p1', 's2', 1, '{\"type\":\"text\",\"text\":\"intro\\nthe AlphaFold run is in out/\\nbye\"}');
             INSERT INTO part VALUES ('p2', 's3', 1, '{\"type\":\"text\",\"text\":\"alphafold too\"}');
             INSERT INTO part VALUES ('p3', 's1', 1, '{\"type\":\"tool\",\"text\":\"alphafold\"}');",
        )
        .unwrap();
        drop(c);
        let hits = find(&root, "alphafold", 10).unwrap();
        assert_eq!(hits.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), ["s2"]);
        assert_eq!(hits[0].snippet, "the AlphaFold run is in out/");
        let by_title = find(&root, "fold", 10).unwrap();
        assert_eq!(by_title.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), ["s2", "s1"]);
        assert_eq!(by_title[1].snippet, "Fold proteins");
        assert!(find(&root, "100%", 10).unwrap().is_empty(), "% is literal");
        assert!(find(&root, " ", 10).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_long_line_is_cut_around_the_words() {
        let long = format!("{} needle {}", "a".repeat(200), "b".repeat(200));
        let s = snippet(&long, "NEEDLE");
        assert!(s.starts_with('…') && s.ends_with('…') && s.contains("needle"), "{s}");
        assert!(s.chars().count() <= 162);
    }
}
