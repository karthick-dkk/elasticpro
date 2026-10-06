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

use regex::Regex;
use std::sync::LazyLock;

static READONLY_POST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(^|/)_(search|msearch|count|field_caps|mget|explain|validate/query|render/template|terms_enum|search_shards|async_search|eql/search|sql|sql/translate|analyze|rank_eval|resolve/index|knn_search)(/|\?|$)",
    )
    .expect("static regex")
});

/// Why a particular request is allowed to write, if it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Writes {
    /// Read-only: GET/HEAD and search-family POSTs only.
    Blocked,
    /// A person asked for this one in the UI, having unlocked writes for the session.
    Operator,
    /// `readOnly: false` in the config — everything is permitted.
    Config,
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
/// used by the guard below and by the fleet cache to decide that a request changed
/// something it holds.
pub fn is_read(method: &str, path: &str) -> bool {
    let m = method.trim().to_ascii_uppercase();
    if m == "GET" || m == "HEAD" {
        return true;
    }
    let bare = path.split('?').next().unwrap_or("/");
    m == "POST" && READONLY_POST.is_match(bare)
}

/// `Some(reason)` when the request must be refused.
pub fn write_guard(writes: Writes, method: &str, path: &str) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The old two-argument shape, kept so the read/write cases below stay readable.
    fn guard(read_only: bool, method: &str, path: &str) -> Option<String> {
        write_guard(Writes::decide(read_only, false, false), method, path)
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
    fn the_refusal_says_how_to_proceed() {
        let msg = guard(true, "DELETE", "/idx").expect("blocked");
        assert!(msg.contains("DELETE"));
        assert!(msg.contains("Allow writes"), "the operator needs to be told the way out: {msg}");
    }
}
