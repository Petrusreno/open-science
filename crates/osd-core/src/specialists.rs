// Specialists (#144): subagents the user defines in the app — a name, when to
// use it, its own instructions, and which skills and connectors it may use.
//
// Each one is an ordinary OpenCode agent file in the app profile,
// `<xdg-config>/opencode/agent/<id>.md`, so the runtime does all the real work:
// the main agent delegates to it through the task tool by its description, the
// `skill` permission filters the skills it is shown, and a `<server>_*` deny
// strips a connector's tools from its requests (all verified against the
// bundled 1.18 runtime).
//
// Two properties of that runtime shape this file:
//
// - ONE invalid agent file makes every request the runtime answers fail
//   (measured: `ConfigInvalidError` on GET /agent for a bad `color`), and only
//   a restart recovers. So nothing reaches disk without passing `validate`, and
//   the file is rendered from typed fields, never from text the UI assembled.
// - The frontmatter is YAML, and this crate has no YAML parser. It is written
//   as one JSON object instead — JSON is YAML, so the runtime reads it as is —
//   which makes reading our own files back an exact `serde_json` parse.
//
// Only files carrying `MARKER` are ours to edit or delete. Agent files the user
// wrote by hand stay theirs: the app lists them but never rewrites them, since
// a rewrite from these few fields would drop everything else they set.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::env::Env;
use crate::runtime::{
    effective_config_file, restart_sidecar_if_running, tighten_private, write_atomic,
    xdg_config_home,
};

/// First frontmatter line of every specialist file the app manages.
const MARKER: &str = "# Managed by Open Science Desktop (Specialists). Edits made here are overwritten.";

/// The runtime's own agents. A file with one of these names would replace the
/// built-in agent rather than add a specialist.
const NATIVE_AGENTS: &[&str] = &["build", "plan", "general", "explore", "title", "summary", "compaction"];

const MAX_ID: usize = 48;
const MAX_DESCRIPTION: usize = 1_000;
const MAX_INSTRUCTIONS: usize = 50_000;
const MAX_SKILL_NAME: usize = 128;
const MAX_MODEL: usize = 256;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Specialist {
    /// The agent name: file name, task-tool `subagent_type`, model-override key.
    pub id: String,
    /// When to use it. The main agent reads this to decide when to delegate.
    pub description: String,
    /// `#rrggbb`, or None for the default ink.
    #[serde(default)]
    pub color: Option<String>,
    /// Replaces the runtime's default system prompt; empty keeps the default.
    #[serde(default)]
    pub instructions: String,
    /// None: every skill. Some(list): only these (an empty list: none).
    #[serde(default)]
    pub skills: Option<Vec<String>>,
    /// Connectors (MCP servers) it may NOT use, as tool-name prefixes — see
    /// `connector_prefix`. A denylist because that is what the runtime can
    /// express: connector tools share one namespace with built-in tools, so
    /// there is no pattern for "every connector but these".
    #[serde(default)]
    pub blocked_connectors: Vec<String>,
    /// `provider/model` it runs on, or "" to follow the default model. Kept in
    /// `opencode.json` under `agent.<id>.model` with the other per-agent models
    /// (Settings › Models edits the same key), not in the agent file.
    #[serde(default)]
    pub model: String,
}

/// The prefix the runtime puts in front of a connector's tool names:
/// `<server>_<tool>`, with every character outside `[A-Za-z0-9_-]` replaced by
/// `_` (OpenCode `mcp/catalog.ts`). Idempotent, so the UI may pass either a
/// server name or a prefix it got back from `list`.
pub fn connector_prefix(server: &str) -> String {
    server
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

/// Letters and digits of any script (`论文写作` is a valid agent name — verified
/// on the bundled runtime), lowercase where the script has case, in groups
/// joined by single hyphens. That also keeps it a safe file name: no `/`, `.`,
/// spaces or anything else a path could trip on.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= MAX_ID
        && id.split('-').all(|part| {
            !part.is_empty() && part.chars().all(|c| c.is_alphanumeric() && !c.is_uppercase())
        })
}

/// A skill name becomes a permission PATTERN, where `*` and `?` are wildcards.
fn valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_SKILL_NAME
        && name.trim() == name
        && !name.chars().any(|c| c == '*' || c == '?' || c.is_control())
}

fn valid_color(color: &str) -> bool {
    color.len() == 7
        && color.starts_with('#')
        && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Every field the runtime will parse, checked before anything is written.
pub fn validate(s: &Specialist) -> Result<(), String> {
    if !valid_id(&s.id) {
        return Err(format!(
            "invalid specialist id \"{}\": use lowercase letters, digits and single hyphens (at most {MAX_ID} characters)",
            s.id
        ));
    }
    if NATIVE_AGENTS.contains(&s.id.as_str()) {
        return Err(format!("\"{}\" is a built-in agent", s.id));
    }
    if s.description.trim().is_empty() {
        return Err("a specialist needs a description of when to use it".into());
    }
    if s.description.chars().count() > MAX_DESCRIPTION {
        return Err(format!("the description is longer than {MAX_DESCRIPTION} characters"));
    }
    if s.instructions.chars().count() > MAX_INSTRUCTIONS {
        return Err(format!("the instructions are longer than {MAX_INSTRUCTIONS} characters"));
    }
    if let Some(color) = &s.color {
        if !valid_color(color) {
            return Err(format!("invalid color \"{color}\": expected #rrggbb"));
        }
    }
    if let Some(bad) = s.skills.iter().flatten().find(|n| !valid_skill_name(n)) {
        return Err(format!("invalid skill name \"{bad}\""));
    }
    if s.blocked_connectors.iter().any(|c| connector_prefix(c).is_empty()) {
        return Err("invalid connector name".into());
    }
    let model_ok = s.model.is_empty()
        || (s.model.len() <= MAX_MODEL
            && s.model.split_once('/').is_some_and(|(p, m)| !p.is_empty() && !m.is_empty())
            && !s.model.chars().any(|c| c.is_control() || c.is_whitespace()));
    if !model_ok {
        return Err(format!("invalid model \"{}\": expected provider/model", s.model));
    }
    Ok(())
}

/// The file the runtime reads. `serde_json::Map` keeps keys sorted, which is
/// also the order the runtime evaluates them in — and inside `skill` that puts
/// `"*"` (0x2A) ahead of every legal skill name, so the catch-all deny comes
/// first and the allows after it win, as last-match-wins needs.
pub fn render(s: &Specialist) -> String {
    let mut permission = Map::new();
    match &s.skills {
        None => {}
        Some(list) if list.is_empty() => {
            permission.insert("skill".into(), json!("deny"));
        }
        Some(list) => {
            let mut rules = Map::new();
            rules.insert("*".into(), json!("deny"));
            for name in list {
                rules.insert(name.clone(), json!("allow"));
            }
            permission.insert("skill".into(), Value::Object(rules));
        }
    }
    for server in &s.blocked_connectors {
        permission.insert(format!("{}_*", connector_prefix(server)), json!("deny"));
    }

    let mut front = Map::new();
    front.insert("description".into(), json!(s.description.trim()));
    front.insert("mode".into(), json!("subagent"));
    if let Some(color) = &s.color {
        front.insert("color".into(), json!(color));
    }
    if !permission.is_empty() {
        front.insert("permission".into(), Value::Object(permission));
    }
    let instructions = s.instructions.trim();
    format!(
        "---\n{MARKER}\n{}\n---\n{}{}",
        Value::Object(front),
        instructions,
        if instructions.is_empty() { "" } else { "\n" }
    )
}

/// Split a markdown agent file into (frontmatter lines, body).
fn split_frontmatter(text: &str) -> Option<(Vec<&str>, &str)> {
    let rest = text.trim_start_matches('\u{feff}').strip_prefix("---")?;
    let rest = rest.strip_prefix("\r\n").or_else(|| rest.strip_prefix('\n'))?;
    let mut lines = Vec::new();
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        offset += line.len();
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "---" {
            return Some((lines, &rest[offset..]));
        }
        lines.push(trimmed);
    }
    None
}

/// True when the file was written by `render` — the app may rewrite it.
fn is_managed(text: &str) -> bool {
    split_frontmatter(text).is_some_and(|(lines, _)| lines.first() == Some(&MARKER))
}

/// Read back a file `render` wrote. None for anything else.
pub fn parse(id: &str, text: &str) -> Option<Specialist> {
    let (lines, body) = split_frontmatter(text)?;
    if lines.first() != Some(&MARKER) {
        return None;
    }
    let json: String = lines[1..].iter().filter(|l| !l.trim_start().starts_with('#')).copied().collect();
    let front: Map<String, Value> = serde_json::from_str(&json).ok()?;
    let permission = front.get("permission").and_then(Value::as_object);
    let skills = match permission.and_then(|p| p.get("skill")) {
        None => None,
        Some(Value::Object(rules)) => Some(
            rules
                .iter()
                .filter(|(name, action)| name.as_str() != "*" && action.as_str() == Some("allow"))
                .map(|(name, _)| name.clone())
                .collect(),
        ),
        Some(_) => Some(Vec::new()),
    };
    let blocked_connectors = permission
        .into_iter()
        .flatten()
        .filter(|(key, action)| key.as_str() != "skill" && action.as_str() == Some("deny"))
        .filter_map(|(key, _)| key.strip_suffix("_*").map(str::to_owned))
        .collect();
    Some(Specialist {
        id: id.to_string(),
        description: front.get("description")?.as_str()?.to_string(),
        color: front.get("color").and_then(Value::as_str).map(str::to_owned),
        instructions: body.trim().to_string(),
        skills,
        blocked_connectors,
        model: String::new(),
    })
}

fn agent_dir(env: &Env) -> Result<PathBuf, String> {
    Ok(xdg_config_home(env)?.join("opencode").join("agent"))
}

/// Names the app itself ships into the same directory (the reviewer); a user
/// file of that name would be overwritten on the next start.
fn bundled_agent_names(env: &Env) -> Vec<String> {
    let Some(dir) = env.resource("profile/agent") else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|e| e.path().file_stem().and_then(|s| s.to_str()).map(str::to_owned))
        .collect()
}

/// The managed specialists in the app profile, sorted by id.
pub fn list(env: &Env) -> Result<Vec<Specialist>, String> {
    let Ok(entries) = std::fs::read_dir(agent_dir(env)?) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<Specialist> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension()? != "md" {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_string();
            parse(&id, &std::fs::read_to_string(&path).ok()?)
        })
        .collect();
    let config = std::fs::read_to_string(effective_config_file(env)?).unwrap_or_default();
    let models: std::collections::HashMap<String, String> =
        crate::opencode_config::agent_models(&config).into_iter().collect();
    for s in &mut out {
        s.model = models.get(&s.id).cloned().unwrap_or_default();
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Create (`create: true`) or update one specialist, then restart the sidecar —
/// the runtime builds its agent list when it loads its config.
pub fn save(env: &Env, specialist: Specialist, create: bool) -> Result<(), String> {
    validate(&specialist)?;
    let dir = agent_dir(env)?;
    let path = dir.join(format!("{}.md", specialist.id));
    if create {
        // `agents/` is scanned too: a file there would collide by name.
        let taken = path.exists()
            || xdg_config_home(env)?.join("opencode").join("agents").join(format!("{}.md", specialist.id)).exists()
            || bundled_agent_names(env).contains(&specialist.id);
        if taken {
            return Err(format!("an agent called \"{}\" already exists", specialist.id));
        }
    } else {
        ensure_managed(&path)?;
    }
    write_atomic(&path, &render(&specialist))?;
    // The model, in the same restart. A pinned effort belongs to the model it
    // was chosen for and may not exist on the new one, so it goes when the
    // model changes (Settings › Models can set it again).
    let config = effective_config_file(env)?;
    let existing = std::fs::read_to_string(&config).unwrap_or_default();
    let id = specialist.id.as_str();
    let current = crate::opencode_config::agent_models(&existing)
        .into_iter()
        .find(|(agent, _)| agent == id)
        .map(|(_, model)| model)
        .unwrap_or_default();
    if current != specialist.model {
        let want = Some(specialist.model.as_str()).filter(|m| !m.is_empty());
        let updated = crate::opencode_config::set_agent_variant(
            &crate::opencode_config::set_agent_model(&existing, id, want),
            id,
            None,
        );
        write_atomic(&config, &updated)?;
        tighten_private(&config);
    }
    restart_sidecar_if_running(env)?;
    Ok(())
}

/// Delete one specialist, with the per-agent model and effort it was pinned to
/// (a later specialist of the same name must not inherit them).
pub fn delete(env: &Env, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("invalid specialist id \"{id}\""));
    }
    let path = agent_dir(env)?.join(format!("{id}.md"));
    ensure_managed(&path)?;
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    let config = effective_config_file(env)?;
    let existing = std::fs::read_to_string(&config).unwrap_or_default();
    let cleared = crate::opencode_config::set_agent_variant(
        &crate::opencode_config::set_agent_model(&existing, id, None),
        id,
        None,
    );
    if cleared != existing {
        write_atomic(&config, &cleared)?;
        tighten_private(&config);
    }
    restart_sidecar_if_running(env)?;
    Ok(())
}

fn ensure_managed(path: &Path) -> Result<(), String> {
    let text = std::fs::read_to_string(path).map_err(|_| "this specialist no longer exists".to_string())?;
    if is_managed(&text) {
        Ok(())
    } else {
        Err("this agent file was not created by the app; edit it by hand instead".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Specialist {
        Specialist {
            id: "stats-reviewer".into(),
            description: "Reviews statistics: tests, \"assumptions\", 多重比较\nsecond line".into(),
            color: Some("#2563EB".into()),
            instructions: "  You review statistics.\n\nBe strict.  ".into(),
            skills: Some(vec!["r-stats".into(), "python-stats".into()]),
            blocked_connectors: vec!["pubmed".into(), "open-science-browser".into()],
            model: String::new(),
        }
    }

    #[test]
    fn render_writes_marker_json_frontmatter_and_body() {
        let text = render(&sample());
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "---");
        assert_eq!(lines[1], MARKER);
        let front: Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(front["mode"], "subagent");
        assert_eq!(front["color"], "#2563EB");
        assert_eq!(front["permission"]["pubmed_*"], "deny");
        assert_eq!(front["permission"]["open-science-browser_*"], "deny");
        assert_eq!(lines[3], "---");
        assert!(text.ends_with("---\nYou review statistics.\n\nBe strict.\n"));
    }

    /// Last match wins in the runtime, so the catch-all deny must come before
    /// the allows — the serialized order IS the evaluation order.
    #[test]
    fn skill_catch_all_deny_precedes_the_allows() {
        let text = render(&sample());
        let deny = text.find(r#""*":"deny""#).unwrap();
        assert!(deny < text.find(r#""python-stats":"allow""#).unwrap());
        assert!(deny < text.find(r#""r-stats":"allow""#).unwrap());
    }

    #[test]
    fn parse_round_trips_render() {
        let s = sample();
        let back = parse(&s.id, &render(&s)).unwrap();
        assert_eq!(back.description, s.description);
        assert_eq!(back.color, s.color);
        assert_eq!(back.instructions, "You review statistics.\n\nBe strict.");
        let mut skills = s.skills.clone().unwrap();
        skills.sort();
        assert_eq!(back.skills, Some(skills));
        assert_eq!(back.blocked_connectors, vec!["open-science-browser", "pubmed"]);
    }

    #[test]
    fn skill_scopes_round_trip() {
        let mut s = sample();
        s.skills = None;
        assert!(!render(&s).contains("\"skill\""));
        assert_eq!(parse(&s.id, &render(&s)).unwrap().skills, None);
        s.skills = Some(vec![]);
        assert!(render(&s).contains(r#""skill":"deny""#));
        assert_eq!(parse(&s.id, &render(&s)).unwrap().skills, Some(vec![]));
    }

    #[test]
    fn minimal_specialist_has_no_color_permission_or_body() {
        let s = Specialist {
            id: "a".into(),
            description: "Does a".into(),
            color: None,
            instructions: String::new(),
            skills: None,
            blocked_connectors: vec![],
            model: String::new(),
        };
        let text = render(&s);
        assert_eq!(text, format!("---\n{MARKER}\n{{\"description\":\"Does a\",\"mode\":\"subagent\"}}\n---\n"));
        assert_eq!(parse("a", &text).unwrap(), s);
    }

    #[test]
    fn connector_prefix_matches_the_runtime_sanitizer() {
        assert_eq!(connector_prefix("my server.v2"), "my_server_v2");
        assert_eq!(connector_prefix("open-science-browser"), "open-science-browser");
        assert_eq!(connector_prefix(&connector_prefix("a.b")), "a_b");
    }

    #[test]
    fn hand_written_files_are_not_ours() {
        let hand = "---\ndescription: mine\nmode: subagent\ntemperature: 0.2\n---\nPrompt\n";
        assert!(parse("mine", hand).is_none());
        assert!(!is_managed(hand));
        assert!(is_managed(&render(&sample())));
    }

    #[test]
    fn validate_rejects_what_would_break_the_runtime() {
        let ok = sample();
        assert!(validate(&ok).is_ok());
        for id in ["", "Stats", "a--b", "-a", "a-", "a b", "a/b", "../x", "a.b", "论文 写作", "build", "explore"] {
            assert!(validate(&Specialist { id: id.into(), ..ok.clone() }).is_err(), "{id}");
        }
        for id in ["论文写作", "논문-작성", "méthodes", "r2-review"] {
            assert!(validate(&Specialist { id: id.into(), ..ok.clone() }).is_ok(), "{id}");
        }
        assert!(validate(&Specialist { id: "x".repeat(MAX_ID + 1), ..ok.clone() }).is_err());
        assert!(validate(&Specialist { id: "写".repeat(MAX_ID), ..ok.clone() }).is_ok(), "counted in characters");
        for model in ["gpt-5", "/x", "a/", "a/b c", "a/b\n"] {
            assert!(validate(&Specialist { model: model.into(), ..ok.clone() }).is_err(), "{model}");
        }
        assert!(validate(&Specialist { model: "openai/gpt-5".into(), ..ok.clone() }).is_ok());
        assert!(validate(&Specialist { description: "  ".into(), ..ok.clone() }).is_err());
        for color in ["pink", "#12345", "#1234567", "#GGGGGG"] {
            assert!(validate(&Specialist { color: Some(color.into()), ..ok.clone() }).is_err(), "{color}");
        }
        for skill in ["*", "a?", " a", ""] {
            assert!(validate(&Specialist { skills: Some(vec![skill.into()]), ..ok.clone() }).is_err());
        }
    }

    fn temp_env(tag: &str) -> (Env, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "os-spec-{tag}-{}-{}",
            std::process::id(),
            crate::runtime::random_hex(4)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        (Env::new(dir.clone(), dir.join("res"), None, "0.0.0".into()), dir)
    }

    #[test]
    fn save_list_update_delete() {
        let (env, dir) = temp_env("crud");
        let s = sample();
        save(&env, s.clone(), true).unwrap();
        assert!(save(&env, s.clone(), true).unwrap_err().contains("already exists"));
        assert_eq!(list(&env).unwrap().len(), 1);

        let updated = Specialist { description: "New".into(), ..s.clone() };
        save(&env, updated, false).unwrap();
        assert_eq!(list(&env).unwrap()[0].description, "New");

        // Its model is saved with it, and read back by `list`; an unchanged
        // model keeps the effort pinned to it, a new one drops it.
        let config = effective_config_file(&env).unwrap();
        write_atomic(&config, r#"{"agent":{"stats-reviewer":{"model":"a/b","variant":"high"}}}"#).unwrap();
        assert_eq!(list(&env).unwrap()[0].model, "a/b");
        save(&env, Specialist { model: "a/b".into(), ..s.clone() }, false).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(v["agent"]["stats-reviewer"]["variant"], "high");
        save(&env, Specialist { model: "c/d".into(), ..s.clone() }, false).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(v["agent"]["stats-reviewer"]["model"], "c/d");
        assert!(v["agent"]["stats-reviewer"].get("variant").is_none());

        // A non-Latin name is a file name like any other.
        save(&env, Specialist { id: "论文写作".into(), ..s.clone() }, true).unwrap();
        assert!(list(&env).unwrap().iter().any(|x| x.id == "论文写作"));
        delete(&env, "论文写作").unwrap();

        // The model pinned to it goes with it.
        delete(&env, &s.id).unwrap();
        assert!(list(&env).unwrap().is_empty());
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert!(v.get("agent").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn never_touches_hand_written_or_bundled_agents() {
        let (env, dir) = temp_env("foreign");
        let agents = agent_dir(&env).unwrap();
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::write(agents.join("mine.md"), "---\ndescription: mine\n---\nhi\n").unwrap();
        let mine = Specialist { id: "mine".into(), ..sample() };
        assert!(save(&env, mine.clone(), false).is_err());
        assert!(save(&env, mine, true).is_err());
        assert!(delete(&env, "mine").is_err());
        assert!(agents.join("mine.md").exists());
        assert!(list(&env).unwrap().is_empty());

        let bundled = dir.join("res").join("profile").join("agent");
        std::fs::create_dir_all(&bundled).unwrap();
        std::fs::write(bundled.join("reviewer.md"), "x").unwrap();
        assert!(save(&env, Specialist { id: "reviewer".into(), ..sample() }, true).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
