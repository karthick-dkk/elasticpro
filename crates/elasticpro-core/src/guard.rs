//! READ-ONLY GUARD — the single chokepoint for every request the app makes.
//!
//! GET and HEAD are always allowed. POST is allowed only for the search family, where
//! the method is a transport detail (the query travels in the body) and the API cannot
//! mutate cluster state. Everything else — PUT, DELETE, any other POST — is refused
//! before a socket is opened.
//!
//! There are exactly two ways a write ever leaves this process, and neither of them is
//! a page deciding on its own:
//!
//! * `readOnly: false` in the config — a decision on disk, applying to everything.
//! * An action a person took in the UI — a request typed in the REST console, a snapshot
//!   created or deleted from the Snapshots page. Two things must both be true: the
//!   operator unlocked writes for the session (`WRITE_UNLOCK`, never persisted) *and*
//!   that one request carries `allowWrites`. So an automatic refresh, a page load or a
//!   future code path cannot write even while the session is unlocked — only the request
//!   a person actually asked for.
//!
//! One thing writes without a person present: the scheduled log-delay measurement in
//! `delay_sink.rs`, hosted edition only. It is not a third way in. It takes the first
//! one — it refuses to run unless the config already permits writes — and it cannot take
//! the second, because the session unlock is never persisted and a timer holds no
//! session. Arming it is itself an admin action, so two people-made decisions still
//! stand between this guard and every document it indexes. If anything else ever wants
//! to write on a timer, it belongs on that same footing, and the sentence above should
//! keep saying two.
//!
//! One narrow exception that writes no data: the ES task reaper (`tasks.rs`) may send
//! `POST /_tasks/<id>/_cancel` — and nothing else — for a task it has just read from the
//! cluster and verified as ours and read-only. It stops a search nobody is waiting for; it
//! cannot change an index, a setting or a document. `Writes::decide` never returns that
//! permission; only the reaper constructs it, and the guard still checks the exact shape of
//! the path.

//!
//! One more, as narrow, for the history store (docs/HISTORY.md, `history_store.rs`): a
//! dedicated Elasticsearch endpoint that is **not** a monitored cluster. Its requests carry
//! `Writes::HistoryRead` or `Writes::HistoryWrite`, which only the core constructs, only for
//! a request it routes to the store's own address, and which `history_guard` holds to exact
//! shapes: `GET /`, `POST /_security/user/_has_privileges`, `POST /<prefix>-…/_search`, and —
//! for `HistoryWrite` only, given only when `HISTORY_STORE_WRITES=true` and an admin armed it
//! after a passing test — `PUT /_index_template/<prefix>-…` (mappings only) and `POST /_bulk`
//! whose every action indexes into `<prefix>-…`. No delete, no update, no ILM, nothing else.
//! A monitored cluster never sees either: `readOnly` and the session unlock are not consulted
//! and cannot grant them.

/// Why a particular request is allowed to write, if it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Writes {
    /// Read-only: GET/HEAD and search-family POSTs only.
    Blocked,
    /// A person asked for this one in the UI, having unlocked writes for the session.
    Operator,
    /// `readOnly: false` in the config — everything is permitted.
    Config,
    /// The ES task reaper cancelling one verified task of ours: `POST /_tasks/<id>/_cancel`
    /// exactly, and nothing else. See the module comment.
    VerifiedTaskCancel,
    /// A request to the history store, which may only read: `GET /`, the privilege check and
    /// searches on its prefix. See `history_guard`.
    HistoryRead,
    /// A request to the history store with both of its gates open: also the index template
    /// and `_bulk` into its prefix. See `history_guard`.
    HistoryWrite,
}

impl Writes {
    /// The two gates an operator-initiated write needs, resolved into one answer.
    ///
    /// `read_only` is the config's setting; `unlocked` is the session switch the
    /// operator flipped; `requested` is the flag the acting page puts on that request.
    pub fn decide(read_only: bool, unlocked: bool, requested: bool) -> Writes {
        if !read_only {
            Writes::Config
        } else if unlocked && requested {
            Writes::Operator
        } else {
            Writes::Blocked
        }
    }
}

/// Whether a request only reads: GET, HEAD, or a search-family POST. The one definition,
/// used by the guard below, by `auth::authorize` to keep every role but admin to reads,
/// and by the fleet cache to decide that a request changed something it holds.
pub fn is_read(method: &str, path: &str) -> bool {
    let m = method.trim().to_ascii_uppercase();
    if m == "GET" || m == "HEAD" {
        return true;
    }
    m == "POST" && is_read_post(path.split('?').next().unwrap_or("/"))
}

/// A POST that only reads: the read endpoint must BE the endpoint, not merely appear in the
/// path.
///
/// This used to be a regex that accepted `_search` anywhere, and the URL parser that sends
/// the request disagreed with it about what the path was: `/_search/../_bulk` matched and
/// reached Elasticsearch as `POST /_bulk`; `/idx/_doc/_search` matched and indexed a
/// document whose id is `_search`; `/idx/_delete_by_query#/_search` lost its fragment on
/// the way out. So each segment is percent-decoded and judged as Elasticsearch will read
/// it: nothing a parser would rewrite or split (dot segments, slashes or backslashes once
/// decoded, fragments, control characters) is accepted, every segment before the endpoint
/// must be an index name (they cannot start with `_`), and the endpoint is followed only by
/// the suffixes it really has.
///
/// Percent-encoding itself is fine: the pages search several indices at once as
/// `/a%2Cb%2Cc/_search`, and refusing every `%` turned a user's ordinary log search into
/// "not available to the user role".
fn is_read_post(bare: &str) -> bool {
    // Printable ASCII only: the URL parser silently drops tabs and newlines, so `.\t.` would
    // leave here as `..`.
    if !bare.chars().all(|c| c.is_ascii_graphic()) || bare.contains(['\\', '#']) {
        return false;
    }
    let mut segs: Vec<String> = Vec::new();
    for raw in bare.split('/').filter(|s| !s.is_empty()) {
        let Some(seg) = percent_decode(raw) else { return false };
        // What a decoded segment must not hold: anything that would make it more than one
        // segment, or something other than what was checked, on the way to Elasticsearch.
        if seg == "." || seg == ".." || seg.contains(['/', '\\', '#', '?', '%'])
            || seg.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return false;
        }
        segs.push(seg);
    }
    let segs: Vec<&str> = segs.iter().map(String::as_str).collect();
    // `_all` is the one index target that starts with `_`; anything else that does is an API.
    let Some(k) = segs.iter().position(|s| s.starts_with('_') && *s != "_all") else { return false };
    match (segs[k], &segs[k + 1..]) {
        ("_search" | "_msearch" | "_count" | "_field_caps" | "_mget" | "_terms_enum" | "_search_shards"
            | "_knn_search" | "_rank_eval" | "_analyze" | "_sql" | "_async_search", []) => true,
        ("_search" | "_msearch", ["template"]) | ("_search", ["scroll"]) | ("_validate", ["query"])
            | ("_eql", ["search"]) | ("_sql", ["translate"]) | ("_render", ["template"]) => true,
        ("_render", ["template", id]) | ("_explain", [id]) => !id.starts_with('_'),
        ("_index_template", ["_simulate"]) => k == 0,
        ("_index_template", ["_simulate" | "_simulate_index", name]) => k == 0 && !name.starts_with('_'),
        _ => false,
    }
}

/// `%XX` decoded once, as UTF-8; `None` for a malformed escape or bytes that are not UTF-8.
pub(crate) fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `POST /_tasks/<node>:<n>/_cancel`, with nothing before, after or around it.
pub fn is_task_cancel(method: &str, path: &str) -> bool {
    method.trim().eq_ignore_ascii_case("POST")
        && path.strip_prefix("/_tasks/").and_then(|r| r.strip_suffix("/_cancel")).is_some_and(crate::tasks::is_task_id)
}

/// `Some(reason)` when the request must be refused.
pub fn write_guard(writes: Writes, method: &str, path: &str) -> Option<String> {
    // The history store's permissions need the prefix and the body to be judged; anything that
    // reaches here with one of them went past `history_guard`, so it is refused outright.
    if matches!(writes, Writes::HistoryRead | Writes::HistoryWrite) {
        return Some(format!("Blocked: a history store request must be judged by its own guard, not {} {path}",
                            method.trim().to_ascii_uppercase()));
    }
    if writes == Writes::VerifiedTaskCancel {
        return if is_task_cancel(method, path) || is_read(method, path) {
            None
        } else {
            Some(format!("Blocked: the task reaper may only cancel a task, not {} {path}", method.trim().to_ascii_uppercase()))
        };
    }
    if writes != Writes::Blocked || is_read(method, path) {
        return None;
    }
    let m = method.trim().to_ascii_uppercase();
    let bare = path.split('?').next().unwrap_or("/");
    Some(format!(
        "Blocked by read-only mode: {m} {bare}. This build only sends GET/HEAD plus search-family POSTs. \
         Turn on \"Allow writes\" (REST console or Snapshots page) to send a request you asked \
         for by hand, or set `readOnly: false` in the config to allow writes everywhere."
    ))
}

/// Whether `prefix` may name the history store's indices: lower case, `[a-z0-9._-]`, not
/// starting with `-`, `_`, `+` or `.`, 1–100 characters. The one definition the settings and
/// the guard both use; nothing that could widen a pattern (`*`, `,`) can be in it.
pub fn history_prefix_ok(prefix: &str) -> bool {
    !prefix.is_empty() && prefix.len() <= 100
        && !prefix.starts_with(['-', '_', '+', '.'])
        && prefix.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'))
}

/// An index name the history store may be written to: `<prefix>-` and then `[a-z0-9._-]`.
fn history_index_ok(prefix: &str, name: &str) -> bool {
    name.strip_prefix(prefix).and_then(|r| r.strip_prefix('-')).is_some_and(|rest| {
        !rest.is_empty() && rest.len() <= 150
            && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'))
    })
}

/// A search target on the history store: `<prefix>-` and then `[a-z0-9._*-]` (a pattern
/// within the prefix, never a list).
fn history_pattern_ok(prefix: &str, name: &str) -> bool {
    name.strip_prefix(prefix).and_then(|r| r.strip_prefix('-')).is_some_and(|rest| {
        !rest.is_empty() && rest.len() <= 150
            && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-' | b'*'))
    })
}

/// The history store's guard: `Some(reason)` when the request must be refused.
///
/// `HistoryRead` allows exactly `GET /`, `POST /_security/user/_has_privileges` and
/// `POST /<prefix>-…/_search` (a handful of harmless parameters). `HistoryWrite` adds
/// `PUT /_index_template/<prefix>-…` whose body is index patterns inside the prefix and
/// mappings (nothing else: no settings, so no ILM), and `POST /_bulk` with no parameters
/// whose every action is `index` or `create`, `_index` inside the prefix and no key but
/// `_index` and `_id`. Anything else — a delete, an update, an ILM call, any other path — is
/// refused, and a prefix that is not a plain index-name prefix refuses everything.
pub fn history_guard(writes: Writes, prefix: &str, method: &str, path: &str, body: Option<&str>) -> Option<String> {
    let m = method.trim().to_ascii_uppercase();
    let refuse = |why: &str| Some(format!("Blocked by the history store guard: {m} {}: {why}", path.split('?').next().unwrap_or(path)));
    if !matches!(writes, Writes::HistoryRead | Writes::HistoryWrite) {
        return refuse("not a history store request");
    }
    if !history_prefix_ok(prefix) {
        return refuse("the store's prefix is not a plain index name prefix");
    }
    let (bare, query) = path.split_once('?').unwrap_or((path, ""));
    if !bare.chars().all(|c| c.is_ascii_graphic()) || bare.contains(['\\', '#', '%']) || query.contains('#') {
        return refuse("the path is not a plain path");
    }
    let segs: Vec<&str> = bare.split('/').filter(|s| !s.is_empty()).collect();
    if segs.iter().any(|s| *s == "." || *s == "..") {
        return refuse("the path is not a plain path");
    }
    match (m.as_str(), segs.as_slice()) {
        ("GET", []) => None,
        ("POST", ["_security", "user", "_has_privileges"]) if query.is_empty() => None,
        ("POST", [target, "_search"]) if history_pattern_ok(prefix, target) => {
            let fine = query.split('&').filter(|q| !q.is_empty()).all(|q| {
                matches!(q.split('=').next().unwrap_or(""), "ignore_unavailable" | "allow_no_indices" | "filter_path" | "size" | "track_total_hits")
            });
            if fine { None } else { refuse("a parameter this search does not use") }
        }
        ("PUT", ["_index_template", name]) if writes == Writes::HistoryWrite && query.is_empty() && history_index_ok(prefix, name) => {
            match body.and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok()) {
                Some(v) if template_body_ok(prefix, &v) => None,
                _ => refuse("an index template here holds index patterns inside the prefix and mappings, nothing else"),
            }
        }
        ("POST", ["_bulk"]) if writes == Writes::HistoryWrite && query.is_empty() => match body {
            Some(b) => bulk_body_ok(prefix, b).err().and_then(|why| refuse(&why)),
            None => refuse("an empty bulk"),
        },
        ("PUT", ["_index_template", _]) | ("POST", ["_bulk"]) if writes == Writes::HistoryRead => {
            refuse("writing to the history store needs HISTORY_STORE_WRITES=true in config.txt and Write history armed after a passing test")
        }
        _ => refuse("the history store takes its index template, bulk writes into its prefix and searches on it, nothing else"),
    }
}

fn template_body_ok(prefix: &str, v: &serde_json::Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    if !o.keys().all(|k| matches!(k.as_str(), "index_patterns" | "template" | "priority" | "_meta")) {
        return false;
    }
    let patterns_ok = o.get("index_patterns").and_then(|p| p.as_array()).is_some_and(|a| {
        !a.is_empty() && a.iter().all(|p| p.as_str().is_some_and(|p| history_pattern_ok(prefix, p)))
    });
    let template_ok = o.get("template").and_then(|t| t.as_object()).is_some_and(|t| t.keys().all(|k| k == "mappings"));
    patterns_ok && template_ok
}

/// Every action line of a bulk body: `index` or `create`, `_index` inside the prefix, no other
/// key than `_index` and `_id`, each followed by one document line.
fn bulk_body_ok(prefix: &str, body: &str) -> Result<(), String> {
    let mut lines = body.lines().filter(|l| !l.trim().is_empty());
    let mut n = 0usize;
    while let Some(action) = lines.next() {
        let v: serde_json::Value = serde_json::from_str(action).map_err(|_| "a bulk action line is not JSON".to_string())?;
        let o = v.as_object().filter(|o| o.len() == 1).ok_or("a bulk action line names one action")?;
        let (kind, meta) = o.iter().next().ok_or("an empty bulk action")?;
        if kind != "index" && kind != "create" {
            return Err(format!("a {kind:?} action: the history store is only ever added to"));
        }
        let meta = meta.as_object().ok_or("a bulk action without its index")?;
        if !meta.keys().all(|k| k == "_index" || k == "_id") {
            return Err("a bulk action carries more than _index and _id".into());
        }
        let index = meta.get("_index").and_then(|i| i.as_str()).unwrap_or("");
        if !history_index_ok(prefix, index) {
            return Err(format!("a bulk action targets {index:?}, outside {prefix}-*"));
        }
        let doc = lines.next().ok_or("a bulk action without its document")?;
        if !serde_json::from_str::<serde_json::Value>(doc).is_ok_and(|d| d.is_object()) {
            return Err("a bulk document is not a JSON object".into());
        }
        n += 1;
    }
    if n == 0 { Err("an empty bulk".into()) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_search_is_a_read_only_where_it_is_the_endpoint() {
        for p in ["/logs-*/_search", "/_search?size=0", "/a,b/_count", "/_msearch", "/_search/template", "/idx/_validate/query",
                  "/idx/_explain/doc-1", "/_sql?format=txt", "/_sql/translate", "/idx/_field_caps", "/_mget", "/idx/_eql/search",
                  "/_index_template/_simulate_index/logs-x", "/_render/template", "/idx/_async_search", "/_analyze", "/_all/_search", "/_all/_count",
                  // The pages' own multi-index search, commas encoded.
                  "/logstash-linux-2026.10.16%2Clogstash-windows-2026.10.16/_search", "/logs%2A/_count"] {
            assert!(super::is_read("POST", p), "{p} reads");
        }
        for p in ["/_search/../_bulk", "/_search/%2e%2e/_delete_by_query", "/_search/..\\_bulk", "/idx/_delete_by_query#/_search",
                  "/idx/_doc/_search", "/idx/_update/_search", "/idx/_create/_search", "/_bulk", "/idx/_doc", "/_reindex?x=/_search",
                  "/idx/_search/extra", "/_snapshot/r/s/_restore", "/idx/_explain/_bulk", "/idx/./_search", "/idx%2F_doc/_search",
                  "/idx/_close", "/_index_template/x", "/_all/_doc/_search", "/_all/_bulk",
                  "/_search/.\t./_bulk", "/_search/.\n./_bulk", "/_search/..\r/_bulk", "/_search/ ../_bulk", "/idx/_bulk\t/_search",
                  "/_search/%2E%2E/_bulk", "/idx%2F_doc/_search", "/idx%5C..%5C_bulk/_search", "/idx%23/_search", "/idx%3F/_search",
                  "/idx%0A/_search", "/idx%25/_search", "/idx%zz/_search", "/idx%2/_search", "/%5Fbulk/_search", "/idx/%5Fdoc/_search"] {
            assert!(!super::is_read("POST", p), "{p} must count as a write");
        }
        assert!(super::is_read(" get ", "/anything/../at/all"), "a GET is a read, wherever it points");
        assert!(!super::is_read("PUT", "/idx/_search"));
    }

    use super::*;

    /// The old two-argument shape, kept so the read/write cases below stay readable.
    fn guard(read_only: bool, method: &str, path: &str) -> Option<String> {
        write_guard(Writes::decide(read_only, false, false), method, path)
    }

    #[test]
    fn simulating_a_template_is_a_read() {
        assert!(is_read("POST", "/_index_template/_simulate_index/logs-app-2026.10.14"));
        assert!(is_read("POST", "/_index_template/_simulate"));
        assert!(is_read("POST", "/_index_template/_simulate/logs-app"));
        assert!(!is_read("PUT", "/_index_template/logs-app"), "saving one is still a write");
        assert!(!is_read("POST", "/_index_template/logs-app"), "a POST that is not a simulate is still a write");
    }

    #[test]
    fn allows_reads_and_search() {
        assert!(guard(true, "GET", "/_cluster/health").is_none());
        assert!(guard(true, "HEAD", "/").is_none());
        assert!(guard(true, "POST", "/logstash-*/_search?size=0").is_none());
        assert!(guard(true, "POST", "/_msearch").is_none());
        assert!(guard(true, "POST", "/_sql?format=json").is_none());
        assert!(guard(true, "POST", "/idx/_count").is_none());
    }
    #[test]
    fn blocks_everything_else() {
        assert!(guard(true, "PUT", "/idx").is_some());
        assert!(guard(true, "DELETE", "/idx").is_some());
        assert!(guard(true, "POST", "/_slm/policy/daily/_execute").is_some());
        assert!(guard(true, "POST", "/idx/_doc").is_some());
        assert!(guard(true, "POST", "/_searchx").is_some());
        assert!(guard(true, "post", "/_cluster/reroute").is_some());
        assert!(guard(true, "POST", "/_search_shards_not").is_some());
    }
    #[test]
    fn off_switch() {
        assert!(guard(false, "DELETE", "/idx").is_none());
    }

    #[test]
    fn an_operator_write_needs_both_gates() {
        use Writes::*;
        // read_only, unlocked, requested
        assert_eq!(Writes::decide(true, false, false), Blocked);
        assert_eq!(Writes::decide(true, true, false), Blocked, "unlocked alone must not let a poll write");
        assert_eq!(Writes::decide(true, false, true), Blocked, "a page asking alone must not be enough");
        assert_eq!(Writes::decide(true, true, true), Operator);
        assert_eq!(Writes::decide(false, false, false), Config, "the config switch still applies to everything");
    }

    #[test]
    fn an_unlocked_session_may_write_but_a_background_request_may_not() {
        let asked_for = Writes::decide(true, true, true);
        let background = Writes::decide(true, true, false);
        assert!(write_guard(asked_for, "DELETE", "/logstash-2026.01.01").is_none());
        assert!(write_guard(background, "DELETE", "/logstash-2026.01.01").is_some());
        // reads are unaffected either way
        assert!(write_guard(background, "GET", "/_cluster/health").is_none());
    }

    #[test]
    fn the_reaper_may_cancel_a_task_and_nothing_else() {
        let r = Writes::VerifiedTaskCancel;
        assert!(write_guard(r, "POST", "/_tasks/oTUltX4IQMOUUVeiohTt8A:4711/_cancel").is_none());
        for (m, p) in [("POST", "/_tasks/_cancel"), ("POST", "/_tasks/n:1/_cancel?actions=*"), ("POST", "/_tasks/n:1/../../_bulk/_cancel"),
                       ("DELETE", "/idx"), ("POST", "/_bulk"), ("PUT", "/_tasks/n:1/_cancel"), ("POST", "/_tasks/n%3A1/_cancel"),
                       ("POST", "/x/_tasks/n:1/_cancel")] {
            assert!(write_guard(r, m, p).is_some(), "{m} {p}");
        }
        assert_ne!(Writes::decide(true, true, true), r, "no person's switch ever grants it");
    }

    #[test]
    fn the_refusal_says_how_to_proceed() {
        let msg = guard(true, "DELETE", "/idx").expect("blocked");
        assert!(msg.contains("DELETE"));
        assert!(msg.contains("Allow writes"), "the operator needs to be told the way out: {msg}");
    }

    #[test]
    fn the_history_store_guard_allows_its_own_shapes_and_nothing_else() {
        let (r, w, p) = (Writes::HistoryRead, Writes::HistoryWrite, "elasticpro-history");
        let bulk = "{\"index\":{\"_index\":\"elasticpro-history-volume-2026.11\",\"_id\":\"prod|2026-11-03\"}}\n{\"day\":\"2026-11-03\"}\n";
        let tpl = r#"{"index_patterns":["elasticpro-history-*"],"priority":200,"template":{"mappings":{"dynamic":false}}}"#;
        for writes in [r, w] {
            assert!(history_guard(writes, p, "GET", "/", None).is_none());
            assert!(history_guard(writes, p, "POST", "/_security/user/_has_privileges", Some("{}")).is_none());
            assert!(history_guard(writes, p, "POST", "/elasticpro-history-volume-*/_search?ignore_unavailable=true", Some("{}")).is_none());
        }
        assert!(history_guard(w, p, "POST", "/_bulk", Some(bulk)).is_none());
        assert!(history_guard(w, p, "PUT", "/_index_template/elasticpro-history-template", Some(tpl)).is_none());
        // Reads only until both gates are open.
        assert!(history_guard(r, p, "POST", "/_bulk", Some(bulk)).unwrap().contains("HISTORY_STORE_WRITES"));
        assert!(history_guard(r, p, "PUT", "/_index_template/elasticpro-history-template", Some(tpl)).is_some());
        for (m, path, body) in [
            ("DELETE", "/elasticpro-history-volume-2026.11", None),
            ("DELETE", "/_index_template/elasticpro-history-template", None),
            ("PUT", "/_ilm/policy/x", Some("{}")),
            ("PUT", "/_index_template/logstash", Some(tpl)),
            ("POST", "/_bulk?pipeline=x", Some(bulk)),
            ("POST", "/elasticpro-history-volume-2026.11/_bulk", Some(bulk)),
            ("POST", "/elasticpro-history-volume-2026.11/_delete_by_query", Some("{}")),
            ("POST", "/elasticpro-history-volume-2026.11/_update_by_query", Some("{}")),
            ("POST", "/logstash-*/_search", Some("{}")),
            ("POST", "/elasticpro-history-*,logstash-*/_search", Some("{}")),
            ("POST", "/elasticpro-history-*/_search/../../_bulk", Some("{}")),
            ("POST", "/elasticpro-history-x/_search?scroll=1m", Some("{}")),
            ("POST", "/elasticpro-history-x%2Clogstash/_search", Some("{}")),
            ("GET", "/_cat/indices", None),
            ("GET", "/elasticpro-history-x/_doc/1", None),
            ("PUT", "/elasticpro-history-x/_doc/1", Some("{}")),
            ("POST", "/_snapshot/r/s/_restore", Some("{}")),
        ] {
            assert!(history_guard(w, p, m, path, body).is_some(), "{m} {path} must be refused");
        }
        // Every action of a bulk is judged, not the first.
        let mixed = format!("{bulk}{{\"delete\":{{\"_index\":\"elasticpro-history-volume-2026.11\",\"_id\":\"x\"}}}}\n");
        assert!(history_guard(w, p, "POST", "/_bulk", Some(&mixed)).is_some());
        let outside = format!("{bulk}{{\"index\":{{\"_index\":\"logstash-2026.11.03\"}}}}\n{{}}\n");
        assert!(history_guard(w, p, "POST", "/_bulk", Some(&outside)).unwrap().contains("logstash"));
        let piped = "{\"index\":{\"_index\":\"elasticpro-history-volume-2026.11\",\"pipeline\":\"p\"}}\n{}\n";
        assert!(history_guard(w, p, "POST", "/_bulk", Some(piped)).is_some());
        let near = "{\"index\":{\"_index\":\"elasticpro-historyx-volume\"}}\n{}\n";
        assert!(history_guard(w, p, "POST", "/_bulk", Some(near)).is_some(), "the prefix and its dash, not a longer name");
        // A template with settings could carry an ILM policy: refused.
        let with_settings = r#"{"index_patterns":["elasticpro-history-*"],"template":{"settings":{"index.lifecycle.name":"x"},"mappings":{}}}"#;
        assert!(history_guard(w, p, "PUT", "/_index_template/elasticpro-history-template", Some(with_settings)).is_some());
        let wide = r#"{"index_patterns":["*"],"template":{"mappings":{}}}"#;
        assert!(history_guard(w, p, "PUT", "/_index_template/elasticpro-history-template", Some(wide)).is_some());
        // Neither permission reaches the ordinary guard, and no person's switch grants one.
        assert!(write_guard(w, "GET", "/").is_some());
        assert!(history_guard(Writes::Config, p, "GET", "/", None).is_some());
        for (ro, un, rq) in [(true, true, true), (false, false, false), (false, true, true)] {
            let d = Writes::decide(ro, un, rq);
            assert!(d != r && d != w);
        }
        // A prefix that could widen a pattern refuses everything.
        for bad in ["", "*", "a,b", "-x", ".x", "_x", "A", "a b"] {
            assert!(!history_prefix_ok(bad), "{bad:?}");
            assert!(history_guard(w, bad, "GET", "/", None).is_some());
        }
    }
}
