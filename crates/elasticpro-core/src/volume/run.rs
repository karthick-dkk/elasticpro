//! The core's half: the `VOLUME_*` messages, the runs, and the timer.
//!
//! The timer exists only where `Edition::schedules()` — the hosted daemon, the one edition
//! still running when nobody is looking — and is started by the bridge binary, never by
//! `Core::new`, so the desktop app and the tests have none. Desktop asks for a run from
//! Indices › Summary when the last one is older than today's `collectAt`.
//!
//! A run only reads (`_cat`, `_field_caps`, `_search`), so it works under read-only and
//! needs no write gate. It does take the other two the poller takes: the emergency stop
//! (nothing is sent; the timer tries again next tick) and an unreachable cluster (left
//! alone until the health probe says it is back).

use super::collect::{self, Indices, RowResolution, Split};
use super::derive::{self, Totals};
use super::schedule::{self, day_key, month_key, parse_day};
use super::settings::{self, Layers, Source, VolumeSettings};
use super::store::{ClusterState, Store};
use super::{LayoutTable, RunState, FIELD_KEYS, LAYOUT_TABLES, RUN_EVERY_MS};
use crate::auth::Caller;
use crate::bridge::Core;
use crate::fleet::entry::ReachState;
use chrono::{Duration, NaiveDate, NaiveDateTime};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

fn now_ms() -> i64 {
    crate::fleet::now_ms() as i64
}

fn bad(kind: &str, message: impl Into<String>) -> Value {
    json!({ "ok": false, "kind": kind, "message": message.into() })
}

fn no_store() -> Value {
    bad("no_store", "this core keeps no files (no data directory), so it keeps no volume record")
}

/// What a config file that is there but cannot be used is answered with. Nothing is
/// collected under built-in settings in its place: those may count other fields, keep
/// fewer months (and prune the rest) or run at another hour than the file says.
fn config_unreadable(e: &str) -> Value {
    bad("config_unreadable", e)
}

/// Why a run ended at the emergency stop before it sent anything.
const STOP_BEFORE: &str = "the emergency stop is on: nothing was sent";

/// Settings as resolved for one request, with where they came from.
pub(crate) struct Resolved {
    pub settings: VolumeSettings,
    managed: Vec<&'static str>,
    pub source: Source,
    overrides: Vec<String>,
}

/// How `volume_collect` is to run: who it says it is in the request log, which days (all
/// that are unfinished, or a report's period), when to stop and whom to tell how far it got.
pub(crate) struct CollectOpts<'a> {
    pub origin: &'static str,
    pub period: Option<(NaiveDate, NaiveDate)>,
    /// Asked between days: `Some(reason)` ends the collection there.
    pub stop: &'a (dyn Fn() -> Option<String> + Send + Sync),
    pub progress: &'a (dyn Fn(u64, u64) + Send + Sync),
    /// The settings are ones the record may be pruned by (`Core::volume_prunes`). Even then
    /// months go only after a run that finished without an error.
    pub prune: bool,
}

/// What one collection did.
#[derive(Debug, Default)]
pub(crate) struct Collected {
    pub searched: u64,
    pub total: u64,
    /// The first thing that went wrong (a request, a day), as the status shows it.
    pub error: Option<String>,
    /// Why it stopped early, when `stop` said so.
    pub interrupted: Option<String>,
    /// The days this collection changed in the record (`YYYY-MM-DD`): what the history store
    /// is sent (`history_store::history_volume_changed`).
    pub changed_days: std::collections::BTreeSet<String>,
}

/// A request a person asked for (the field check, the pattern preview): their class and
/// their name in the request log, not the timer's.
fn person_asked(mut r: crate::http::EsRequest, origin: &str, caller: Option<&Caller>) -> crate::http::EsRequest {
    r.class = crate::gate::Class::Interactive;
    r.origin = Some(origin.into());
    r.user = caller.map(|c| c.name.clone());
    r.timeout_ms = Some(30_000);
    r
}

/// The pattern preview's figures from a `_cat/indices?h=index` answer: how many indices
/// the pattern matches, how many count by the date in their name and how many are split by
/// time, with the first of each by name. Matching nothing is an answer, not a failure.
pub(crate) fn pattern_preview(rows: &Value, ind: &Indices) -> Value {
    let mut names: Vec<&str> = rows.as_array().into_iter().flatten().filter_map(|r| r.get("index").and_then(Value::as_str)).collect();
    names.sort_unstable();
    names.dedup();
    let (mut dated, mut split): (Vec<&str>, Vec<&str>) = (vec![], vec![]);
    for n in &names {
        match ind.place(n) {
            collect::Placement::Dated(..) => dated.push(n),
            collect::Placement::TimeSplit(_) => split.push(n),
            collect::Placement::Skipped => {}
        }
    }
    json!({ "ok": true, "matched": names.len(), "dated": dated.len(), "undated": split.len(),
            "datedExample": dated.first(), "undatedExample": split.first() })
}

fn int_arg(msg: &Value, key: &str, default: u64, lo: u64, hi: u64) -> u64 {
    msg.get(key).and_then(Value::as_u64).unwrap_or(default).clamp(lo, hi)
}

/// The Daily view's figures on `today`: rows, totals and sources over the `days` shown,
/// and the cards. The record is read from as far back as either needs — a row's average
/// reaches `avg_days` before the window, a card may reach to the first of the month or 30
/// days back (`derive::cards_from`) — so a short window does not shrink a card.
#[cfg(test)]
pub(crate) fn daily_view(store: &Store, id: &str, s: &VolumeSettings, days: i64, avg_days: u32, source: Option<&str>, today: NaiveDate) -> Value {
    daily_view_with(store, id, s, days, avg_days, source, today, vec![])
}

/// The first day the Daily view reads on `today`: its window, the rows' averages before it
/// and the cards (`daily_view`).
pub(crate) fn daily_reads_from(today: NaiveDate, days: i64, avg_days: u32) -> NaiveDate {
    let from = today - Duration::days(days - 1);
    (from - Duration::days(avg_days as i64)).min(derive::cards_from(today, avg_days))
}

/// `daily_view`, with days read back from the history store for what the local record does
/// not hold (`from_store`): a local day always wins, and a row from the store says
/// `source: "history"`. One definition of every figure either way — the same `derive`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn daily_view_with(store: &Store, id: &str, s: &VolumeSettings, days: i64, avg_days: u32, source: Option<&str>, today: NaiveDate,
                              from_store: Vec<super::Day>) -> Value {
    let from = today - Duration::days(days - 1);
    let hist_from = daily_reads_from(today, days, avg_days);
    let mut kept = store.days_between(id, hist_from, today);
    let local: std::collections::BTreeSet<String> = kept.iter().map(|d| d.day.clone()).collect();
    let mut stored = std::collections::BTreeSet::new();
    for d in from_store {
        if !local.contains(&d.day) && parse_day(&d.day).is_some_and(|x| x >= hist_from && x <= today) && stored.insert(d.day.clone()) {
            kept.push(d);
        }
    }
    kept.sort_by(|a, b| a.day.cmp(&b.day));
    let history = derive::history(&kept, source);
    let window: Vec<&super::Day> = kept.iter().filter(|d| parse_day(&d.day).is_some_and(|x| x >= from)).collect();
    let sources: std::collections::BTreeSet<String> = window.iter().flat_map(|d| d.sources.keys().cloned()).collect();
    let shown: Vec<(&super::Day, Totals)> = window.iter().filter_map(|d| Some((*d, Totals::of(d, source)?))).collect();
    let rows: Vec<Value> = shown.iter()
        .map(|(d, t)| {
            let mut row = derive::daily_row(d, t, &history, avg_days, s.size_basis, source);
            if stored.contains(&d.day) {
                row["source"] = json!("history");
            }
            row
        })
        .collect();
    let totals = derive::window_totals(&shown.iter().map(|(_, t)| t).collect::<Vec<_>>());
    let today_at = window.iter().find(|d| d.day == day_key(today)).map(|d| d.totals_at);
    json!({
        "cards": derive::cards(&history, today, avg_days, s.size_basis, today_at),
        "days": rows, "totals": totals, "sources": sources, "source": source, "topAvailable": source.is_none(),
        "window": { "from": day_key(from), "to": day_key(today), "days": days, "avgDays": avg_days },
    })
}

/// The month files a collection refreshes, oldest first: a report's period's months, or
/// every month kept on disk (`kept`) and every month the listing or the time split has a
/// day in; none older than `oldest` (`YYYY-MM`, the first month `keepMonths` keeps).
pub(crate) fn months_to_refresh(kept: impl FnOnce() -> Vec<String>, listing: &collect::Listing, split: &Split,
                                period: Option<(NaiveDate, NaiveDate)>, oldest: &str) -> Vec<String> {
    let mut months: Vec<String> = match period {
        Some((from, to)) => schedule::months_between(from, to),
        None => {
            let mut m = kept();
            m.extend(listing.days.keys().chain(split.days()).map(|d| month_key(*d)));
            m
        }
    };
    months.sort();
    months.dedup();
    months.retain(|m| m.as_str() >= oldest);
    months
}

impl Core {
    /* ------------------------------------ settings ------------------------------------ */

    /// The clusters file, when this core has one (hosted: ELASTICPRO_CONFIG). `Ok(None)`:
    /// there is no config file at all, and the settings are the message's (desktop) or
    /// built-in. `Err`: there is one and it cannot be read or parsed — then nothing is
    /// collected (docs/VOLUME.md "Collection"), the run is tried again next tick, and the
    /// reason is the cluster's `lastError`.
    pub(crate) async fn volume_config(&self) -> Result<Option<Value>, String> {
        if !self.has_config_file() {
            return Ok(None);
        }
        self.read_config_file().await.map(Some).map_err(|e| {
            format!("the config file could not be read: {}", e.get("message").and_then(Value::as_str).unwrap_or("unknown error"))
        })
    }

    /// Whether a run under these settings may prune the record: settings from the config
    /// file, from a desktop message, or built-in on a core that has no file to read them
    /// from (hosted without ELASTICPRO_CONFIG). A desktop request that carried no settings
    /// resolves to built-in too, and its `keepMonths` is nobody's decision.
    pub(crate) fn volume_prunes(&self, r: &Resolved) -> bool {
        match r.source {
            Source::File | Source::Message => true,
            Source::Builtin => self.edition() == crate::auth::Edition::Hosted && !self.has_config_file(),
        }
    }

    /// The settings for one cluster (or the defaults), from the config file when there is
    /// one, else from the message's `volume`, else built-in; config.txt over all of them.
    ///
    /// The message's `volume` counts only on the desktop editions. On hosted the settings
    /// are the config file's — which an admin edits — and a request from anybody else must
    /// not be able to say what the timer's next run counts.
    ///
    /// A message about one cluster (`clusterId`, or `clusterIds` naming only it) carries
    /// that cluster's override as `volume.cluster`; one about several carries each one's as
    /// `volume.clusters[id]` (`settings::layers_from_message`).
    pub(crate) fn volume_resolve(&self, raw: Option<&Value>, cluster: Option<&str>, msg: Option<&Value>) -> Resolved {
        let from_msg = msg.filter(|_| self.edition() != crate::auth::Edition::Hosted)
            .and_then(|m| m.get("volume")).filter(|v| v.is_object());
        let own = cluster.is_some_and(|id| msg.is_some_and(|m| {
            m.get("clusterId").and_then(Value::as_str) == Some(id)
                || m.get("clusterIds").and_then(Value::as_array).is_some_and(|a| a.len() == 1 && a[0].as_str() == Some(id))
        }));
        let (layers, source, overrides) = match (raw, from_msg) {
            (Some(raw), _) => (settings::layers_from_config(raw, cluster), Source::File, settings::override_ids(raw)),
            (None, Some(v)) => (settings::layers_from_message(v, cluster, own), Source::Message, settings::message_override_ids(v)),
            (None, None) => (Layers::default(), Source::Builtin, vec![]),
        };
        let (settings, managed) = settings::resolve(&layers, crate::settings::get());
        Resolved { settings, managed, source, overrides }
    }

    /* ------------------------------------- status ------------------------------------- */

    fn volume_run_state(&self, id: &str) -> RunState {
        self.volume.runs.lock().get(id).cloned().unwrap_or_default()
    }

    fn volume_status(&self, id: &str, s: &VolumeSettings, st: &ClusterState) -> Value {
        let run = self.volume_run_state(id);
        let next = self.edition().schedules().then(|| {
            let last = st.last_scheduled_day.as_deref().and_then(parse_day);
            schedule::local_to_ms(schedule::next_run(schedule::local_now(), s.collect_time(), last))
        }).flatten();
        json!({
            "lastRunAt": st.last_run_at,
            "nextRunAt": next,
            "running": run.running,
            "progress": run.running.then(|| json!({ "done": run.done, "total": run.total })),
            "lastError": st.last_error,
            "collectAt": s.collect_at,
        })
    }

    pub(crate) fn volume_unreachable(&self, id: &str) -> bool {
        self.fleet.state.lock().reach_state(id) == ReachState::Unreachable
    }

    pub(crate) fn volume_stopped(&self) -> bool {
        self.fleet.cfg.read().stopped(crate::fleet::now_ms())
    }

    /* ------------------------------------- messages ------------------------------------- */

    /// Every `VOLUME_*` message. The gate has already checked the role and that a named
    /// cluster is the caller's (`gate_cluster`).
    pub(crate) async fn volume_msg(self: &Arc<Self>, t: &str, msg: &Value, caller: Option<&Caller>) -> Value {
        match t {
            "VOLUME_LAYOUT_GET" => return self.volume_layouts_get(),
            "VOLUME_LAYOUT_SET" => return self.volume_layouts_set(msg, caller),
            "VOLUME_RUN" => return self.volume_run_msg(msg, caller).await,
            "VOLUME_PATTERN_CHECK" => return self.volume_pattern_check(msg, caller).await,
            "VOLUME_MONTHLY_ALL" => return self.volume_monthly_all(msg, caller).await,
            _ => {}
        }
        // A config file that cannot be read: the record is still shown (under built-in
        // settings, saying so in `configError`), but nothing asks a cluster under them.
        let (raw, config_error) = match self.volume_config().await {
            Ok(raw) => (raw, None),
            Err(e) => (None, Some(e)),
        };
        let id = msg.get("clusterId").and_then(Value::as_str).filter(|s| !s.is_empty());
        let mut out = if t == "VOLUME_SETTINGS" {
            let r = self.volume_resolve(raw.as_ref(), id, Some(msg));
            let visible = self.visible_ids(caller);
            let overrides: Vec<String> = r.overrides.into_iter().filter(|o| visible.as_ref().is_none_or(|v| v.contains(o))).collect();
            // Which of indexPattern / the legacy indexFormat is in force, beside the settings
            // that carry it too, so the page can say so without reading the settings' shape.
            json!({ "ok": true, "clusterId": id, "patternSource": r.settings.pattern_source, "settings": r.settings,
                    "managed": r.managed, "source": r.source.as_str(), "overrides": overrides })
        } else {
            let Some(id) = id else { return bad("bad_request", "clusterId is required") };
            if self.spec_for(id).is_none() {
                return bad("not_found", format!("no cluster {id:?}"));
            }
            let r = self.volume_resolve(raw.as_ref(), Some(id), Some(msg));
            match t {
                "VOLUME_FIELDS_CHECK" => match &config_error {
                    Some(e) => return config_unreadable(e),
                    None => self.volume_fields_check(id, &r.settings, caller).await,
                },
                "VOLUME_DAILY" => self.volume_daily(id, &r.settings, msg).await,
                "VOLUME_MONTHLY" => self.volume_monthly(id, &r.settings, msg).await,
                "VOLUME_BREAKDOWN" => self.volume_breakdown(id, msg),
                _ => bad("bad_message", format!("Unknown message type {t:?}")),
            }
        };
        if let (Some(e), Some(o)) = (config_error, out.as_object_mut()) {
            if o.get("ok") == Some(&Value::Bool(true)) {
                o.insert("configError".into(), json!(e));
            }
        }
        out
    }

    async fn volume_fields_check(self: &Arc<Self>, id: &str, s: &VolumeSettings, caller: Option<&Caller>) -> Value {
        let ind = match Indices::from_settings(s) {
            Ok(i) => i,
            Err(e) => return bad("bad_settings", e),
        };
        // A person asked: their class and their name in the request log, not the timer's.
        let ask = |r: crate::http::EsRequest| person_asked(r, "volume-fields-check", caller);
        let cat = self.es_req(ask(collect::cat_request(id, &ind))).await;
        let Some(rows) = collect::cat_rows(&cat) else { return cat };
        let listing = collect::read_cat(&rows, &ind);
        let time = !listing.time_split.is_empty();
        let fc = self.es_req(ask(collect::field_caps_request(id, &ind, s, time))).await;
        if fc.get("ok").and_then(Value::as_bool) != Some(true) {
            return fc;
        }
        let fc = fc.get("json").unwrap_or(&Value::Null);
        let rows = collect::resolve_rows(fc, s);
        let (resolved, kind, note) = match (time, collect::resolve_time_field(fc, &s.time_field)) {
            (false, _) => (false, Value::Null, "no index is split by time: the time field is not used".to_string()),
            (true, Ok(t)) => (true, json!(t), "date".to_string()),
            (true, Err(why)) => (false, Value::Null, why),
        };
        json!({ "ok": true, "clusterId": id, "glob": ind.expr(),
                "patternSource": s.pattern_source, "dayFrom": s.day_from,
                "indices": { "match": listing.matched, "days": listing.days.len(), "skipped": listing.skipped,
                             "skippedCount": listing.skipped_count, "dated": listing.dated(),
                             "timeSplit": listing.time_split.len() },
                "timeField": { "field": s.time_field, "used": time, "resolved": resolved, "type": kind, "note": note },
                "rows": rows })
    }

    /// `VOLUME_PATTERN_CHECK {clusterId, indexPattern, dayFrom?}` (admin; the gate keeps a
    /// limited admin to their clusters): what a pattern would count on this cluster, before
    /// anybody saves it. One `_cat/indices` request, names only, as the person who asked.
    async fn volume_pattern_check(self: &Arc<Self>, msg: &Value, caller: Option<&Caller>) -> Value {
        let Some(id) = msg.get("clusterId").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
            return bad("bad_request", "clusterId is required");
        };
        if self.spec_for(id).is_none() || !self.visible_ids(caller).is_none_or(|v| v.iter().any(|x| x == id)) {
            return bad("not_found", format!("no cluster {id:?}"));
        }
        let pattern = msg.get("indexPattern").and_then(Value::as_str).unwrap_or("");
        if let Some(why) = settings::index_pattern_problem(pattern) {
            return bad("bad_request", format!("indexPattern {why}"));
        }
        let day_from = match msg.get("dayFrom") {
            None | Some(Value::Null) => settings::DayFrom::Name,
            Some(v) => match v.as_str().and_then(settings::DayFrom::parse) {
                Some(d) => d,
                None => return bad("bad_request", "dayFrom must be name or time"),
            },
        };
        let Some(p) = collect::IndexPattern::new(pattern) else { return bad("bad_request", "indexPattern cannot be used") };
        let ind = Indices { naming: collect::Naming::Pattern(p), day_from, time_field: String::new() };
        let res = self.es_req(person_asked(collect::cat_names_request(id, &ind), "volume-pattern-check", caller)).await;
        let Some(rows) = collect::cat_rows(&res) else {
            let why = res.get("message").and_then(Value::as_str).filter(|m| !m.is_empty())
                .or_else(|| res.pointer("/json/error/reason").and_then(Value::as_str)).unwrap_or("the request failed");
            return json!({ "ok": false, "kind": res.get("kind").cloned().unwrap_or(json!("es_error")), "clusterId": id,
                           "message": format!("_cat/indices: {why}") });
        };
        let mut out = pattern_preview(&rows, &ind);
        out["clusterId"] = json!(id);
        out["indexPattern"] = json!(ind.expr());
        out["dayFrom"] = json!(day_from);
        out
    }

    async fn volume_daily(self: &Arc<Self>, id: &str, s: &VolumeSettings, msg: &Value) -> Value {
        let Some(store) = &self.volume.store else { return no_store() };
        let days = int_arg(msg, "days", 30, 14, 400) as i64;
        let avg_days = int_arg(msg, "avgDays", derive::AVG_DAYS_DEFAULT as u64, 3, 180) as u32;
        let source = msg.get("source").and_then(Value::as_str).filter(|s| !s.is_empty());
        let today = schedule::utc_day(now_ms());
        // What the local record does not reach back to, from the history store (docs/HISTORY.md
        // "Reading back"): one bounded search, and only for days before the record starts.
        let missing = crate::history_store::missing_range(daily_reads_from(today, days, avg_days), today,
                                                          crate::history_store::oldest_local_day(store, id));
        let read = match missing {
            Some((f, t)) => self.history_read_volume(&[id.to_string()], f, t).await,
            None => None,
        };
        let from_store = read.as_ref().and_then(|r| r.days.get(id).cloned()).unwrap_or_default();
        let mut out = daily_view_with(store, id, s, days, avg_days, source, today, from_store);
        out["history"] = read.as_ref().map(|r| r.json()).unwrap_or(Value::Null);
        let st = store.read_state(id);
        if let Some(o) = out.as_object_mut() {
            o.insert("ok".into(), json!(true));
            o.insert("clusterId".into(), json!(id));
            o.insert("settings".into(), json!(s));
            o.insert("status".into(), self.volume_status(id, s, &st));
            o.insert("skipped".into(), json!(st.skipped));
            o.insert("skippedCount".into(), json!(st.skipped_count));
            o.insert("matched".into(), json!(st.matched));
            o.insert("timeSplit".into(), json!(st.time_split));
        }
        out
    }

    fn month_rows(st: &ClusterState, s: &VolumeSettings, months: usize, current: &str) -> Vec<Value> {
        let kept: Vec<_> = st.months.values().filter(|m| m.month.as_str() <= current).collect();
        let skip = kept.len().saturating_sub(months);
        kept.into_iter().skip(skip).map(|m| derive::month_row(m, s.size_basis, current)).collect()
    }

    /// The months shown from the store: the days it holds before the local record starts,
    /// summarised by the same `derive` as the local ones, each row `source: "history"`.
    fn history_month_rows(days: &[super::Day], s: &VolumeSettings, current: &str) -> Vec<Value> {
        let mut by_month: BTreeMap<String, BTreeMap<String, super::Day>> = BTreeMap::new();
        for d in days {
            if let Some(date) = parse_day(&d.day) {
                by_month.entry(month_key(date)).or_default().insert(d.day.clone(), d.clone());
            }
        }
        by_month.iter().filter(|(m, _)| m.as_str() <= current).map(|(m, ds)| {
            let mut row = derive::month_row(&derive::month_summary(m, ds), s.size_basis, current);
            row["source"] = json!("history");
            row
        }).collect()
    }

    /// Local month rows and the store's, a local month winning, the last `months` of them.
    fn merge_month_rows(local: Vec<Value>, stored: Vec<Value>, months: usize) -> Vec<Value> {
        let mut by: BTreeMap<String, Value> = BTreeMap::new();
        for r in stored.into_iter().chain(local) {
            if let Some(m) = r["month"].as_str() {
                by.insert(m.to_string(), r);
            }
        }
        let skip = by.len().saturating_sub(months);
        by.into_values().skip(skip).collect()
    }

    /// The range the store is asked for when the Monthly view shows `months` months: from the
    /// first of the oldest month shown to the day before the local record's first month.
    fn monthly_missing(st: &ClusterState, today: NaiveDate, months: usize) -> Option<(NaiveDate, NaiveDate)> {
        let first = schedule::oldest_kept_month(today, months as u32);
        let oldest_local = st.months.keys().next().and_then(|m| NaiveDate::parse_from_str(&format!("{m}-01"), "%Y-%m-%d").ok());
        crate::history_store::missing_range(first, today, oldest_local)
    }

    async fn volume_monthly(self: &Arc<Self>, id: &str, s: &VolumeSettings, msg: &Value) -> Value {
        let Some(store) = &self.volume.store else { return no_store() };
        let months = int_arg(msg, "months", 13, 1, 36) as usize;
        let today = schedule::utc_day(now_ms());
        let current = month_key(today);
        let st = store.read_state(id);
        let read = match Core::monthly_missing(&st, today, months) {
            Some((f, t)) => self.history_read_volume(&[id.to_string()], f, t).await,
            None => None,
        };
        let stored = read.as_ref().and_then(|r| r.days.get(id)).map(|d| Core::history_month_rows(d, s, &current)).unwrap_or_default();
        let rows = Core::merge_month_rows(Core::month_rows(&st, s, 36, &current), stored, months);
        json!({ "ok": true, "clusterId": id, "settings": s, "status": self.volume_status(id, s, &st),
                "avgPerMonth": derive::avg_per_month(&rows), "months": rows,
                "history": read.as_ref().map(|r| r.json()) })
    }

    /// Every cluster the caller sees, from `state.json` alone. On desktop each cluster's
    /// override comes from the message's `volume.clusters[id]`.
    async fn volume_monthly_all(self: &Arc<Self>, msg: &Value, caller: Option<&Caller>) -> Value {
        let Some(store) = &self.volume.store else { return no_store() };
        let months = int_arg(msg, "months", 13, 1, 36) as usize;
        let current = month_key(schedule::utc_day(now_ms()));
        let (raw, config_error) = match self.volume_config().await {
            Ok(raw) => (raw, None),
            Err(e) => (None, Some(e)),
        };
        let today = schedule::utc_day(now_ms());
        let ids = self.fleet_visible(caller);
        // One search for every cluster whose local record starts after the oldest month shown.
        let states: Vec<ClusterState> = ids.iter().map(|id| store.read_state(id)).collect();
        let missing: Vec<Option<(NaiveDate, NaiveDate)>> = states.iter().map(|st| Core::monthly_missing(st, today, months)).collect();
        let asking: Vec<String> = ids.iter().zip(&missing).filter(|(_, m)| m.is_some()).map(|(id, _)| id.clone()).collect();
        let span = missing.iter().flatten().fold(None::<(NaiveDate, NaiveDate)>, |acc, (f, t)| {
            Some(acc.map_or((*f, *t), |(a, b)| (a.min(*f), b.max(*t))))
        });
        let read = match span {
            Some((f, t)) => self.history_read_volume(&asking, f, t).await,
            None => None,
        };
        let mut out = vec![];
        for ((id, st), miss) in ids.iter().zip(&states).zip(&missing) {
            let name = self.spec_for(id).and_then(|s| s.name).unwrap_or_else(|| id.clone());
            let r = self.volume_resolve(raw.as_ref(), Some(id), Some(msg));
            let stored = match (miss, read.as_ref().and_then(|rb| rb.days.get(id))) {
                (Some((f, t)), Some(days)) => {
                    let mine: Vec<super::Day> = days.iter().filter(|d| parse_day(&d.day).is_some_and(|x| x >= *f && x <= *t)).cloned().collect();
                    Core::history_month_rows(&mine, &r.settings, &current)
                }
                _ => vec![],
            };
            let rows = Core::merge_month_rows(Core::month_rows(st, &r.settings, 36, &current), stored, months);
            out.push(json!({ "clusterId": id, "name": name, "basis": r.settings.size_basis, "months": rows }));
        }
        let mut reply = json!({ "ok": true, "clusters": out, "history": read.as_ref().map(|r| r.json()) });
        if let Some(e) = config_error {
            reply["configError"] = json!(e);
        }
        reply
    }

    fn volume_breakdown(&self, id: &str, msg: &Value) -> Value {
        let Some(store) = &self.volume.store else { return no_store() };
        let field = msg.get("field").and_then(Value::as_str).unwrap_or("");
        if !FIELD_KEYS.contains(&field) {
            return bad("bad_request", format!("field must be one of {}", FIELD_KEYS.join(", ")));
        }
        let today = schedule::utc_day(now_ms());
        let day_arg = |k: &str| msg.get(k).and_then(Value::as_str).map(|s| parse_day(s).ok_or(s.to_string()));
        let to = match day_arg("to") {
            None => today,
            Some(Ok(d)) => d,
            Some(Err(s)) => return bad("bad_request", format!("to {s:?} is not a YYYY-MM-DD day")),
        };
        let from = match day_arg("from") {
            None => to - Duration::days(29),
            Some(Ok(d)) => d,
            Some(Err(s)) => return bad("bad_request", format!("from {s:?} is not a YYYY-MM-DD day")),
        };
        if from > to || (to - from).num_days() > 1200 {
            return bad("bad_request", "from must be on or before to, and the period at most 1200 days");
        }
        let top = int_arg(msg, "top", derive::BREAKDOWN_TOP_DEFAULT as u64, 1, 1000) as usize;
        let days = store.days_between(id, from, to);
        let refs: Vec<&super::Day> = days.iter().collect();
        let mut out = derive::breakdown(&refs, field, top);
        out["ok"] = json!(true);
        out["clusterId"] = json!(id);
        out["period"] = json!({ "from": day_key(from), "to": day_key(to) });
        out
    }

    /* -------------------------------------- layouts -------------------------------------- */

    /// A table's columns, default hidden ones and locked first column (`LAYOUT_TABLES`).
    fn layout_table(table: &str) -> Option<&'static LayoutTable> {
        LAYOUT_TABLES.iter().find(|t| t.name == table)
    }

    fn layout_default(table: &str) -> Value {
        let (cols, hidden) = Core::layout_table(table).map_or((&[][..], &[][..]), |t| (t.columns, t.hidden));
        json!({ "order": cols, "hidden": hidden, "labels": {} })
    }

    /// A stored layout made whole: unknown keys dropped, keys it does not mention appended
    /// in their default order, so a column added in a later version still shows up; a
    /// locked column first and never hidden.
    fn layout_whole(table: &str, stored: Option<&Value>) -> Value {
        let (cols, locked) = Core::layout_table(table).map_or((&[][..], None), |t| (t.columns, t.locked));
        let Some(v) = stored.filter(|v| v.is_object()) else { return Core::layout_default(table) };
        let pick = |k: &str| -> Vec<String> {
            let mut out: Vec<String> = vec![];
            for x in v.get(k).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                if cols.contains(&x) && !out.iter().any(|o| o == x) {
                    out.push(x.to_string());
                }
            }
            out
        };
        let mut order = pick("order");
        for c in cols {
            if !order.iter().any(|o| o == c) {
                order.push(c.to_string());
            }
        }
        let mut hidden = pick("hidden");
        if let Some(l) = locked {
            order.retain(|o| o != l);
            order.insert(0, l.to_string());
            hidden.retain(|h| h != l);
        }
        let labels: Map<String, Value> = v.get("labels").and_then(Value::as_object).into_iter().flatten()
            .filter(|(k, l)| cols.contains(&k.as_str()) && l.is_string()).map(|(k, l)| (k.clone(), l.clone())).collect();
        json!({ "order": order, "hidden": hidden, "labels": labels })
    }

    pub(crate) fn volume_layouts(&self) -> Value {
        let stored = self.volume.store.as_ref().map(Store::read_layouts).unwrap_or(Value::Null);
        let mut out = Map::new();
        for t in LAYOUT_TABLES {
            out.insert(t.name.into(), Core::layout_whole(t.name, stored.get(t.name)));
        }
        Value::Object(out)
    }

    fn volume_layouts_get(&self) -> Value {
        json!({ "ok": true, "layouts": self.volume_layouts() })
    }

    /// `VOLUME_LAYOUT_SET {table, layout:{order, hidden, labels}}`: one shared layout per
    /// table, for everybody. Refused rather than cleaned up when it names a column that
    /// does not exist: a person who sent it should hear that it did not take.
    fn volume_layouts_set(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let Some(store) = &self.volume.store else { return no_store() };
        let table = msg.get("table").and_then(Value::as_str).unwrap_or("");
        let Some(LayoutTable { columns: cols, locked, .. }) = Core::layout_table(table) else {
            let names: Vec<&str> = LAYOUT_TABLES.iter().map(|t| t.name).collect();
            return bad("bad_request", format!("table must be one of {}", names.join(", ")));
        };
        let (cols, locked) = (*cols, *locked);
        let Some(layout) = msg.get("layout").filter(|l| l.is_object()) else { return bad("bad_request", "layout is required") };
        if let Some(l) = locked {
            if layout.get("hidden").and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(l))) {
                return bad("bad_request", format!("hidden: {l} is always shown in the {table} table"));
            }
            if layout.get("order").and_then(Value::as_array).and_then(|a| a.first()).is_some_and(|x| x.as_str() != Some(l)) {
                return bad("bad_request", format!("order: {l} is always first in the {table} table"));
            }
        }
        for k in ["order", "hidden"] {
            match layout.get(k) {
                None | Some(Value::Null) => {}
                Some(Value::Array(a)) => {
                    for x in a {
                        match x.as_str() {
                            Some(c) if cols.contains(&c) => {}
                            _ => return bad("bad_request", format!("{k}: {x} is not a column of the {table} table")),
                        }
                    }
                }
                Some(_) => return bad("bad_request", format!("{k} must be a list of column keys")),
            }
        }
        match layout.get("labels") {
            None | Some(Value::Null) => {}
            Some(Value::Object(m)) => {
                for (k, l) in m {
                    if !cols.contains(&k.as_str()) {
                        return bad("bad_request", format!("labels: {k:?} is not a column of the {table} table"));
                    }
                    let Some(l) = l.as_str() else { return bad("bad_request", format!("labels.{k} must be text")) };
                    if l.chars().count() > 60 || l.chars().any(char::is_control) {
                        return bad("bad_request", format!("labels.{k}: at most 60 characters, no control characters"));
                    }
                }
            }
            Some(_) => return bad("bad_request", "labels must be an object of column key to label"),
        }
        let mut all = store.read_layouts();
        if !all.is_object() {
            all = json!({});
        }
        all[table] = Core::layout_whole(table, Some(layout));
        if let Err(e) = store.write_layouts(&all) {
            return bad("io_error", e);
        }
        let by = caller.map(|c| c.name.clone()).unwrap_or_else(|| "local".into());
        tracing::info!(target: "audit", user = %by, table = %table, "volume column layout saved");
        json!({ "ok": true, "layouts": self.volume_layouts() })
    }

    /* ---------------------------------------- runs ---------------------------------------- */

    /// `VOLUME_RUN {clusterIds?}`: run now, for whoever asks, at most once a minute per
    /// cluster. Absent ids are every cluster the caller sees. A config file that is there
    /// but cannot be read refuses the lot (`config_unreadable`): nothing is collected under
    /// built-in settings in its place.
    async fn volume_run_msg(self: &Arc<Self>, msg: &Value, caller: Option<&Caller>) -> Value {
        if self.volume.store.is_none() {
            return no_store();
        }
        let raw = match self.volume_config().await {
            Ok(raw) => raw,
            Err(e) => return config_unreadable(&e),
        };
        let visible = self.fleet_visible(caller);
        let ids: Vec<String> = match msg.get("clusterIds").and_then(Value::as_array) {
            Some(a) => a.iter().filter_map(Value::as_str).map(String::from).collect(),
            None => visible.clone(),
        };
        let (mut started, mut already, mut too_soon, mut skipped) = (vec![], vec![], vec![], vec![]);
        let stopped = self.volume_stopped();
        let now = crate::fleet::now_ms();
        for id in ids {
            if !visible.contains(&id) {
                skipped.push(json!({ "clusterId": id, "reason": "unknown" }));
                continue;
            }
            if stopped {
                skipped.push(json!({ "clusterId": id, "reason": "stopped" }));
                continue;
            }
            let decision = {
                let mut runs = self.volume.runs.lock();
                let r = runs.entry(id.clone()).or_default();
                if r.running {
                    "already"
                } else if r.asked_at.is_some_and(|t| now.saturating_sub(t) < RUN_EVERY_MS) {
                    "tooSoon"
                } else if self.volume_unreachable(&id) {
                    "unreachable"
                } else {
                    *r = RunState { running: true, done: 0, total: 0, asked_at: Some(now) };
                    "started"
                }
            };
            match decision {
                "already" => already.push(id),
                "tooSoon" => too_soon.push(id),
                "unreachable" => skipped.push(json!({ "clusterId": id, "reason": "unreachable" })),
                _ => {
                    let r = self.volume_resolve(raw.as_ref(), Some(&id), Some(msg));
                    let prune = self.volume_prunes(&r);
                    self.volume_spawn(id.clone(), r.settings, prune, None);
                    started.push(id);
                }
            }
        }
        json!({ "ok": true, "started": started, "already": already, "tooSoon": too_soon,
                "skipped": skipped, "stopped": stopped })
    }

    /// Run one cluster in the background, behind the two-at-once limit. The caller has
    /// already marked it running.
    ///
    /// `scheduled` is set for the timer's run: the cluster's `lastScheduledDay` before the
    /// timer marked today. A scheduled run that ends at the emergency stop — while it waited
    /// for its turn, before `_cat`, or with days left — puts that back, so the first tick
    /// after the stop runs the cluster again. A run that finished, or failed for any other
    /// reason, leaves today marked: at most one scheduled run a day.
    fn volume_spawn(self: &Arc<Self>, id: String, s: VolumeSettings, prune: bool, scheduled: Option<Option<String>>) {
        let core = self.clone();
        tokio::spawn(async move {
            let permit = core.volume.permits.clone().acquire_owned().await;
            // The stop may have come on while this run waited for its permit.
            let result = if core.volume_stopped() {
                Ok(Collected { error: Some(STOP_BEFORE.into()), interrupted: Some(STOP_BEFORE.into()), ..Collected::default() })
            } else {
                core.volume_run_cluster(&id, &s, prune).await
            };
            drop(permit);
            match &result {
                Err(e) => {
                    tracing::warn!(cluster = %id, error = %e, "volume daily: run did not finish");
                    if let Some(store) = &core.volume.store {
                        let _ = store.update_state(&id, |st| st.last_error = Some(e.clone()));
                    }
                }
                Ok(c) if c.interrupted.is_some() => {
                    let why = c.error.clone().or_else(|| c.interrupted.clone()).unwrap_or_default();
                    let why = if scheduled.is_some() { format!("{why}; the scheduled run is tried again when the stop is over") } else { why };
                    tracing::info!(cluster = %id, reason = %why, "volume daily: run ended at the emergency stop");
                    if let Some(store) = &core.volume.store {
                        let _ = store.update_state(&id, |st| {
                            if let Some(prev) = &scheduled {
                                st.last_scheduled_day = prev.clone();
                            }
                            st.last_error = Some(why.clone());
                        });
                    }
                }
                // The day's capacity measurements, once a day: after the scheduled run only.
                Ok(_) => {
                    if scheduled.is_some() {
                        core.history_capacity_after_run(&id).await;
                    }
                }
            }
            if let Some(r) = core.volume.runs.lock().get_mut(&id) {
                r.running = false;
            }
        });
    }

    pub(crate) fn volume_progress(&self, id: &str, done: u64, total: u64) {
        if let Some(r) = self.volume.runs.lock().get_mut(id) {
            r.done = done;
            r.total = total;
        }
    }

    /// One cluster, start to finish (docs/VOLUME.md "Each run, per cluster"): the daily run
    /// and Refresh now.
    async fn volume_run_cluster(self: &Arc<Self>, id: &str, s: &VolumeSettings, prune: bool) -> Result<Collected, String> {
        let stop = || self.volume_stopped().then(|| "the emergency stop came on".to_string());
        let progress = |done, total| self.volume_progress(id, done, total);
        let opts = CollectOpts { origin: "volume-daily", period: None, stop: &stop, progress: &progress, prune };
        self.volume_collect(id, s, &opts).await
    }

    /// The collector, for the daily run and for a report job (`report`), under the same
    /// rules: Background class, the emergency stop, one request at a time, finished days
    /// never asked again. A report job passes its `period` — only the months it touches are
    /// refreshed and only its days searched; the run's status and the prune are left to the
    /// daily run — and a `stop` that also answers to `REPORT_STOP`.
    ///
    /// Ending at the stop is `Ok` with `interrupted` set, whether before anything was sent
    /// or with days left; so is a request that failed while the stop came on.
    pub(crate) async fn volume_collect(self: &Arc<Self>, id: &str, s: &VolumeSettings, opts: &CollectOpts<'_>) -> Result<Collected, String> {
        let out = self.volume_collect_days(id, s, opts).await?;
        // The days it changed, to the history store's queue — only while its gates are open;
        // the local record is written first and never waits for it.
        self.history_volume_changed(id, &out.changed_days);
        Ok(out)
    }

    async fn volume_collect_days(self: &Arc<Self>, id: &str, s: &VolumeSettings, opts: &CollectOpts<'_>) -> Result<Collected, String> {
        let store = self.volume.store.as_ref().ok_or("no data directory")?;
        let ind = Indices::from_settings(s)?;
        if self.volume_stopped() {
            return Ok(Collected { error: Some(STOP_BEFORE.into()), interrupted: Some(STOP_BEFORE.into()), ..Collected::default() });
        }
        let job = opts.period.is_some();
        let tag = |mut r: crate::http::EsRequest| {
            r.origin = Some(opts.origin.into());
            r
        };
        let ok = |v: &Value| v.get("ok").and_then(Value::as_bool) == Some(true);
        let why = |v: &Value| v.get("message").and_then(Value::as_str).unwrap_or("request failed").to_string();
        let started = now_ms();
        let today = schedule::utc_day(started);
        let oldest = month_key(schedule::oldest_kept_month(today, s.keep_months));
        let mut out = Collected::default();

        // 1. Sizes per day, from the names; the indices split by time apart.
        let cat = self.es_req(tag(collect::cat_request(id, &ind))).await;
        let Some(cat_json) = collect::cat_rows(&cat) else {
            let (e, interrupted) = match (opts.stop)() {
                Some(reason) => (format!("{reason} before _cat/indices answered"), Some(reason)),
                None => (format!("_cat/indices: {}", why(&cat)), None),
            };
            if !job {
                store.update_state(id, |st| { st.last_run_at = Some(started); st.last_error = Some(e.clone()); })?;
            }
            out.error = Some(e);
            out.interrupted = interrupted;
            return Ok(out);
        };
        drop(cat);
        let listing = collect::read_cat(&cat_json, &ind);
        drop(cat_json);

        // 1b. The days the time-split indices have documents on: one histogram over all of
        // them, after `_field_caps` says the time field is a date (docs/VOLUME.md step 2).
        let time = !listing.time_split.is_empty();
        let mut rows: Option<Vec<RowResolution>> = None;
        let mut fc_failed: Option<String> = None;
        let mut halted = false;
        let split = if !time {
            Split::None
        } else {
            let open = listing.split_open();
            if open.is_empty() {
                Split::Known { days: Default::default(), complete: false }
            } else {
                let fc = self.es_req(tag(collect::field_caps_request(id, &ind, s, true))).await;
                if ok(&fc) {
                    let fcj = fc.get("json").unwrap_or(&Value::Null);
                    rows = Some(collect::resolve_rows(fcj, s));
                    match collect::resolve_time_field(fcj, &s.time_field) {
                        Err(e) => Split::Unknown(e),
                        Ok(_) => {
                            let (from, to) = opts.period.unwrap_or_else(|| {
                                (NaiveDate::parse_from_str(&format!("{oldest}-01"), "%Y-%m-%d").unwrap_or(today), today)
                            });
                            let h = self.es_req(tag(collect::histogram_request(id, &ind, &open, from, to.min(today)))).await;
                            if ok(&h) {
                                let res = h.get("json").unwrap_or(&Value::Null);
                                match collect::partial_answer(res) {
                                    // A histogram that missed shards may have missed days: a
                                    // day it does not list could still be there.
                                    Some(p) => Split::Unknown(format!("the time split (date_histogram on {}): {p}", s.time_field)),
                                    None => Split::Known { days: collect::read_histogram(res), complete: listing.split_closed() == 0 },
                                }
                            } else if let Some(reason) = (opts.stop)() {
                                out.error = Some(format!("{reason} before the time split answered"));
                                out.interrupted = Some(reason.clone());
                                halted = true;
                                Split::Unknown(reason)
                            } else {
                                Split::Unknown(format!("the time split (date_histogram on {}) failed: {}", s.time_field, why(&h)))
                            }
                        }
                    }
                } else if let Some(reason) = (opts.stop)() {
                    out.error = Some(format!("{reason} before _field_caps answered"));
                    out.interrupted = Some(reason.clone());
                    halted = true;
                    Split::Unknown(reason)
                } else {
                    let e = format!("_field_caps: {}", why(&fc));
                    fc_failed = Some(e.clone());
                    Split::Unknown(e)
                }
            }
        };
        if let Split::Unknown(e) = &split {
            if !halted {
                out.error.get_or_insert_with(|| format!("indices split by time not counted: {e}"));
            }
        }

        let months = months_to_refresh(|| store.months(id), &listing, &split, opts.period, &oldest);
        let in_period = |d: NaiveDate| opts.period.is_none_or(|(f, t)| d >= f && d <= t);
        let mut summaries = BTreeMap::new();
        let mut to_search: Vec<NaiveDate> = vec![];
        for m in &months {
            let mut file = store.read_month(id, m);
            let was_live: std::collections::BTreeSet<String> = file.days.iter().filter(|(_, d)| d.live).map(|(k, _)| k.clone()).collect();
            let mut changed = collect::apply_totals(&mut file.days, m, &listing, &split, started);
            for (k, d) in &file.days {
                if d.totals_at == started || (was_live.contains(k) && !d.live) {
                    out.changed_days.insert(k.clone());
                }
            }
            for (k, d) in file.days.iter_mut() {
                let Some(date) = parse_day(k) else { continue };
                if !in_period(date) {
                    continue;
                }
                let group = listing.days.get(&date);
                if collect::needs_search(d, group, split.has(date)) {
                    to_search.push(date);
                } else if let Some(e) = collect::not_searched_why(d, group, &split, today) {
                    // A past day that stays unfinished says why (docs/VOLUME.md "Store").
                    if d.error.as_deref() != Some(e.as_str()) {
                        d.error = Some(e);
                        out.changed_days.insert(k.clone());
                        changed = true;
                    }
                }
            }
            if changed && !file.days.is_empty() {
                store.write_month(id, m, &file)?;
            }
            if !file.days.is_empty() {
                summaries.insert(m.clone(), derive::month_summary(m, &file.days));
            }
        }

        // 2. Which field each row is (asked above when some index is split by time).
        let rows: Option<Vec<RowResolution>> = if to_search.is_empty() || halted {
            None
        } else if rows.is_some() {
            rows
        } else {
            let fc = match &fc_failed {
                Some(_) => Value::Null,
                None => self.es_req(tag(collect::field_caps_request(id, &ind, s, time))).await,
            };
            if ok(&fc) {
                Some(collect::resolve_rows(fc.get("json").unwrap_or(&Value::Null), s))
            } else if let Some(reason) = (opts.stop)() {
                out.error = Some(format!("{reason} before _field_caps answered"));
                out.interrupted = Some(reason);
                None
            } else {
                // The days stay unfinished and say why; the next run asks again.
                let e = fc_failed.clone().unwrap_or_else(|| format!("_field_caps: {}", why(&fc)));
                let note = format!("not aggregated: {e}; asked again on the next run");
                let mut by_month: BTreeMap<String, Vec<NaiveDate>> = BTreeMap::new();
                for d in &to_search {
                    by_month.entry(month_key(*d)).or_default().push(*d);
                }
                for (m, dates) in by_month {
                    let mut file = store.read_month(id, &m);
                    for date in dates {
                        if let Some(day) = file.days.get_mut(&day_key(date)) {
                            day.error = Some(note.clone());
                            out.changed_days.insert(day_key(date));
                        }
                    }
                    store.write_month(id, &m, &file)?;
                    summaries.insert(m.clone(), derive::month_summary(&m, &file.days));
                }
                out.error.get_or_insert(e);
                None
            }
        };

        // 3. One search per unfinished day, one at a time, a month file at a time.
        if let Some(rows) = rows {
            let body = collect::search_body(&rows, s.top_values);
            let total = to_search.len() as u64;
            out.total = total;
            (opts.progress)(0, total);
            let mut done = 0u64;
            let mut by_month: BTreeMap<String, Vec<NaiveDate>> = BTreeMap::new();
            for d in to_search {
                by_month.entry(month_key(d)).or_default().push(d);
            }
            'months: for (m, dates) in by_month {
                let mut file = store.read_month(id, &m);
                for date in dates {
                    if let Some(reason) = (opts.stop)() {
                        out.error = Some(format!("{reason} after {done} of {total} days"));
                        out.interrupted = Some(reason);
                        store.write_month(id, &m, &file)?;
                        summaries.insert(m.clone(), derive::month_summary(&m, &file.days));
                        break 'months;
                    }
                    let group = listing.group_for(date, &split);
                    let res = self.es_req(tag(collect::search_request(id, &ind, date, &group, &body))).await;
                    if !ok(&res) {
                        // Refused or cut off because the stop came on: not this day's fault.
                        if let Some(reason) = (opts.stop)() {
                            out.error = Some(format!("{reason} after {done} of {total} days"));
                            out.interrupted = Some(reason);
                            store.write_month(id, &m, &file)?;
                            summaries.insert(m.clone(), derive::month_summary(&m, &file.days));
                            break 'months;
                        }
                    }
                    if let Some(day) = file.days.get_mut(&day_key(date)) {
                        out.changed_days.insert(day_key(date));
                        if ok(&res) {
                            collect::apply_search(day, res.get("json").unwrap_or(&Value::Null), &rows, &group, today, now_ms());
                            if let Some(e) = &day.error {
                                out.error.get_or_insert_with(|| format!("{}: {e}", day_key(date)));
                            }
                        } else {
                            let e = format!("the search failed: {}; asked again on the next run", why(&res));
                            out.error.get_or_insert_with(|| format!("{}: {e}", day_key(date)));
                            day.error = Some(e);
                        }
                    }
                    done += 1;
                    out.searched = done;
                    (opts.progress)(done, total);
                }
                store.write_month(id, &m, &file)?;
                summaries.insert(m.clone(), derive::month_summary(&m, &file.days));
            }
        }

        // 4. Month summaries; for the daily run also its status, then what is older than
        // keepMonths goes — only after a run that finished cleanly under settings the
        // record may be pruned by (`CollectOpts::prune`).
        if job {
            store.update_state(id, |st| st.months.extend(summaries))?;
            tracing::info!(cluster = %id, origin = opts.origin, searched = out.searched, error = out.error.as_deref().unwrap_or(""), "volume: days collected for a report");
            return Ok(out);
        }
        let error = out.error.clone();
        // A listing is whole only when the time split is known for every time-split index:
        // otherwise a day with no record may yet have documents (`report` reads `listed_at`).
        let whole = !split.uncertain();
        store.update_state(id, |st| {
            st.last_run_at = Some(started);
            if whole {
                st.listed_at = Some(started);
            }
            st.last_error = error.clone();
            st.matched = listing.matched;
            st.skipped = listing.skipped.clone();
            st.skipped_count = listing.skipped_count;
            st.time_split = listing.time_split.len() as u64;
            st.months.extend(summaries);
        })?;
        if opts.prune && out.error.is_none() && out.interrupted.is_none() {
            store.prune(id, &oldest)?;
        }
        tracing::info!(cluster = %id, days = listing.days.len(), error = error.as_deref().unwrap_or(""), "volume daily: run finished");
        Ok(out)
    }

    /* ---------------------------------------- the timer ---------------------------------------- */

    /// The once-a-day timer. Hosted only; started by the bridge binary.
    pub fn start_volume_daily(self: &Arc<Self>) {
        if !self.edition().schedules() || self.volume.store.is_none() {
            return;
        }
        let core = self.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                core.volume_tick_at(schedule::local_now()).await;
            }
        });
        // No `user`: nobody asked. hosted-check counts audit lines that name one.
        tracing::info!(target: "audit", "volume daily: timer started");
    }

    /// One tick, at the given local time: start every cluster whose run is due. Returns the
    /// clusters started. Public for the tests, which cannot wait for 06:00.
    #[doc(hidden)]
    pub async fn volume_tick_at(self: &Arc<Self>, local: NaiveDateTime) -> Vec<String> {
        use std::sync::atomic::Ordering;
        let Some(store) = &self.volume.store else { return vec![] };
        if self.volume.ticking.swap(true, Ordering::SeqCst) {
            return vec![];
        }
        struct Done<'a>(&'a std::sync::atomic::AtomicBool);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                self.0.store(false, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let _done = Done(&self.volume.ticking);
        // Stopped: nothing is marked, so the run happens on the first tick after the stop ends.
        if self.volume_stopped() {
            return vec![];
        }
        let mut specs = self.all_specs();
        specs.sort_by(|a, b| a.id.cmp(&b.id));
        // A config file that cannot be read: nothing runs and nothing is marked, so the
        // first tick after it is fixed runs what is due. Each cluster says why.
        let raw = match self.volume_config().await {
            Ok(raw) => raw,
            Err(e) => {
                let mut told = 0;
                for spec in &specs {
                    if store.read_state(&spec.id).last_error.as_deref() != Some(e.as_str())
                        && store.update_state(&spec.id, |st| st.last_error = Some(e.clone())).is_ok()
                    {
                        told += 1;
                    }
                }
                if told > 0 {
                    tracing::warn!(error = %e, clusters = told, "volume daily: not run, the config file could not be read");
                }
                return vec![];
            }
        };
        let mut started = vec![];
        for spec in specs {
            let id = spec.id;
            let r = self.volume_resolve(raw.as_ref(), Some(&id), None);
            let prev = store.read_state(&id).last_scheduled_day;
            let last = prev.as_deref().and_then(parse_day);
            if !schedule::is_due(local, r.settings.collect_time(), last) || self.volume_unreachable(&id) {
                continue;
            }
            let begin = {
                let mut runs = self.volume.runs.lock();
                let r = runs.entry(id.clone()).or_default();
                !r.running && {
                    r.running = true;
                    r.done = 0;
                    r.total = 0;
                    true
                }
            };
            if !begin {
                continue;
            }
            // Marked before the run, not after: a run that crashes the process must not be
            // started again by every restart. A run that ends at the stop puts `prev` back.
            let today = day_key(local.date());
            if store.update_state(&id, |st| st.last_scheduled_day = Some(today.clone())).is_err() {
                if let Some(r) = self.volume.runs.lock().get_mut(&id) {
                    r.running = false;
                }
                continue;
            }
            let prune = self.volume_prunes(&r);
            self.volume_spawn(id.clone(), r.settings, prune, Some(prev));
            started.push(id);
        }
        started
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::volume::schedule::months_between;
    use crate::volume::{DAILY_COLUMNS, DAILY_HIDDEN};

    #[test]
    fn months_between_covers_every_month_once() {
        let d = |s: &str| parse_day(s).unwrap();
        assert_eq!(months_between(d("2026-10-29"), d("2026-10-29")), vec!["2026-10"]);
        assert_eq!(months_between(d("2026-01-31"), d("2026-03-01")), vec!["2026-01", "2026-02", "2026-03"]);
        assert_eq!(months_between(d("2025-11-15"), d("2026-02-10")), vec!["2025-11", "2025-12", "2026-01", "2026-02"]);
        let long = months_between(d("2024-01-01"), d("2026-12-31"));
        assert_eq!(long.len(), 36);
        assert_eq!(long.first().map(String::as_str), Some("2024-01"));
        assert_eq!(long.last().map(String::as_str), Some("2026-12"));
    }

    /// The cards do not depend on the table's window: 14 days with a 3-day average on the
    /// 29th still sum the whole month and 30 days of event bytes; the rows stay 14.
    #[test]
    fn the_cards_read_past_a_short_window() {
        let root = std::env::temp_dir().join(format!("ep-volume-view-{}-{}", std::process::id(), now_ms()));
        let store = Store::new(root.clone());
        let d = |s: &str| parse_day(s).unwrap();
        let mut by_month: BTreeMap<String, super::super::store::MonthFile> = BTreeMap::new();
        // 2026-09-25 .. 2026-10-29: 100 bytes primary and 10 event bytes a day.
        let mut day = d("2026-09-25");
        while day <= d("2026-10-29") {
            let f = by_month.entry(month_key(day)).or_insert_with(|| super::super::store::MonthFile { version: 1, ..Default::default() });
            f.days.insert(day_key(day), super::super::Day {
                day: day_key(day), is_final: day < d("2026-10-29"), live: true, indices: 1, pri_bytes: Some(100), total_bytes: Some(200),
                docs: Some(1), event_bytes: Some(10), ..Default::default()
            });
            day += Duration::days(1);
        }
        for (m, f) in &by_month {
            store.write_month("prod", m, f).unwrap();
        }
        let v = daily_view(&store, "prod", &VolumeSettings::default(), 14, 3, None, d("2026-10-29"));
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(v["days"].as_array().unwrap().len(), 14, "the rows are the window's");
        assert_eq!(v["totals"]["priBytes"], 1400, "and so is the totals row");
        assert_eq!(v["cards"]["monthSoFar"]["value"], 2900, "1 Oct .. 29 Oct, not only the window and its average days");
        assert_eq!(v["cards"]["eventBytes30"]["value"], 300, "29 Sep .. 28 Oct");
        assert_eq!(v["cards"]["eventBytes30"]["daysMeasured"], 30);
        assert_eq!(v["cards"]["average"]["value"], 100);
        assert_eq!(v["days"][0]["day"], "2026-10-16");
        assert_eq!(v["days"][0]["avg"], 100, "the first row's average still has its 3 days before");
    }

    /// What a run does with a listing on `today` (docs/VOLUME.md "Each run, per cluster",
    /// step 1, and the search marking past days final), on an empty record: the months it
    /// picks, each day in its own month file, and every open day searched.
    fn collect_on(store: &Store, id: &str, cat: &Value, today: NaiveDate, keep_months: u32) {
        // The built-in pattern (logstash-*): these names carry their day, as under the format.
        let ind = Indices::from_settings(&VolumeSettings::default()).unwrap();
        let listing = collect::read_cat(cat, &ind);
        assert!(listing.time_split.is_empty());
        let oldest = month_key(schedule::oldest_kept_month(today, keep_months));
        for m in months_to_refresh(|| store.months(id), &listing, &Split::None, None, &oldest) {
            let mut file = store.read_month(id, &m);
            collect::apply_totals(&mut file.days, &m, &listing, &Split::None, 1);
            for (k, d) in file.days.iter_mut() {
                let date = parse_day(k).unwrap();
                assert!(collect::needs_search(d, listing.days.get(&date), false), "{k} is searched on {today}");
                assert_eq!(collect::not_searched_why(d, listing.days.get(&date), &Split::None, today), None);
                d.is_final = date < today;
                d.docs = Some(1);
            }
            store.write_month(id, &m, &file).unwrap();
        }
        store.prune(id, &oldest).unwrap();
    }

    /// 45 days of `logstash-<src>-YYYY.MM.DD` ending on `today`, as tools/mock-es.mjs lists
    /// them: two sources, 100 + 50 bytes primary a day.
    fn cat_45_days(today: NaiveDate) -> Value {
        let rows: Vec<Value> = (0..45).flat_map(|n| {
            let d = today - Duration::days(n);
            [("acme", 100), ("beta", 50)].map(|(src, b)| json!({
                "index": format!("logstash-{src}-{}", d.format("%Y.%m.%d")), "status": "open",
                "docs.count": "1", "pri.store.size": b.to_string(), "store.size": (b * 2).to_string(),
            }))
        }).collect();
        Value::Array(rows)
    }

    /// The first of a month, the last of one and New Year's Day: the record a run makes on
    /// that day is the whole window, today included, read across the month (and year)
    /// boundary; "This month so far" starts again on the 1st and yesterday is the last day
    /// of the month before.
    #[test]
    fn the_record_reads_across_month_and_year_ends() {
        let d = |s: &str| parse_day(s).unwrap();
        for (today, months, month_so_far) in [
            ("2026-11-01", vec!["2026-09", "2026-10", "2026-11"], 150),
            ("2026-10-31", vec!["2026-09", "2026-10"], 31 * 150),
            ("2027-01-01", vec!["2026-11", "2026-12", "2027-01"], 150),
            ("2026-12-31", vec!["2026-11", "2026-12"], 31 * 150),
        ] {
            let today = d(today);
            let root = std::env::temp_dir().join(format!("ep-volume-edge-{}-{}-{today}", std::process::id(), now_ms()));
            let store = Store::new(root.clone());
            collect_on(&store, "prod", &cat_45_days(today), today, 13);
            let kept = store.months("prod");
            let v = daily_view(&store, "prod", &VolumeSettings::default(), 30, 7, None, today);
            let one = daily_view(&store, "prod", &VolumeSettings::default(), 30, 7, Some("beta"), today);
            // keepMonths 1 keeps only the current month: on the 1st that is today alone.
            let root1 = root.with_extension("keep1");
            let store1 = Store::new(root1.clone());
            collect_on(&store1, "prod", &cat_45_days(today), today, 1);
            let v1 = daily_view(&store1, "prod", &VolumeSettings::default(), 30, 7, None, today);
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&root1);

            assert_eq!(kept, months, "{today}: one file per month the 45 days touch");
            let rows = v["days"].as_array().unwrap();
            assert_eq!(rows.len(), 30, "{today}: 30 rows");
            assert_eq!(rows[0]["day"], day_key(today - Duration::days(29)), "{today}: the oldest row");
            assert_eq!(rows[29]["day"], day_key(today), "{today}: today is the newest row");
            assert_eq!(rows[29]["final"], false, "{today}: today is not final");
            assert_eq!(rows[28]["final"], true, "{today}: yesterday is");
            assert_eq!(rows[29]["priBytes"], 150);
            assert_eq!(v["window"]["to"], day_key(today));
            assert_eq!(v["totals"]["priBytes"], 30 * 150);
            assert_eq!(v["cards"]["yesterday"]["day"], day_key(today - Duration::days(1)));
            assert_eq!(v["cards"]["yesterday"]["value"], 150);
            assert_eq!(v["cards"]["average"]["daysWithData"], 7);
            assert_eq!(v["cards"]["monthSoFar"]["month"], month_key(today));
            assert_eq!(v["cards"]["monthSoFar"]["value"], month_so_far, "{today}: this month so far");
            assert_eq!(v["sources"], json!(["acme", "beta"]));
            assert_eq!(one["days"].as_array().unwrap().len(), 30, "{today}: a source's rows too");
            assert_eq!(one["totals"]["priBytes"], 30 * 50);
            let first = NaiveDate::parse_from_str(&format!("{}-01", month_key(today)), "%Y-%m-%d").unwrap();
            assert_eq!(v1["days"].as_array().unwrap().len() as i64, ((today - first).num_days() + 1).min(30),
                "{today}: keepMonths 1 keeps the current month, today included");
        }
    }

    #[test]
    fn the_pattern_preview_counts_dated_and_time_split() {
        let ind = |day_from| Indices { naming: collect::Naming::Pattern(collect::IndexPattern::new("logstash-*").unwrap()),
                                       day_from, time_field: String::new() };
        let rows = json!([{ "index": "logstash-win-2026.10.20" }, { "index": "logstash-app" },
                          { "index": "logstash-linux-2026.10.21" }, { "index": "logstash-linux-2026.10" }]);
        let v = pattern_preview(&rows, &ind(settings::DayFrom::Name));
        assert_eq!(v, json!({ "ok": true, "matched": 4, "dated": 2, "undated": 2,
                              "datedExample": "logstash-linux-2026.10.21", "undatedExample": "logstash-app" }));
        let t = pattern_preview(&rows, &ind(settings::DayFrom::Time));
        assert_eq!((t["dated"].as_u64(), t["undated"].as_u64(), t["datedExample"].clone()), (Some(0), Some(4), Value::Null));
        let none = pattern_preview(&json!([]), &ind(settings::DayFrom::Name));
        assert_eq!(none, json!({ "ok": true, "matched": 0, "dated": 0, "undated": 0, "datedExample": null, "undatedExample": null }),
                   "matching nothing is an answer");
    }

    #[test]
    fn the_reports_tables_have_layouts_with_cluster_first() {
        let c = Core::layout_whole("capacity", None);
        assert_eq!(c["order"][0], "cluster");
        assert_eq!(c["order"].as_array().unwrap().len(), crate::volume::CAPACITY_COLUMNS.len());
        let o = Core::layout_whole("overview", Some(&json!({ "order": ["yesterday", "cluster"], "hidden": ["cluster", "type"] })));
        assert_eq!((o["order"][0].as_str(), o["order"][1].as_str()), (Some("cluster"), Some("yesterday")), "cluster locked first");
        assert_eq!(o["hidden"], json!(["type"]), "and never hidden");
        assert!(Core::layout_table("nope").is_none());
    }

    #[test]
    fn a_layout_is_made_whole() {
        let l = Core::layout_whole("daily", Some(&json!({ "order": ["docs", "day", "nope", "docs"], "hidden": ["topTag"], "labels": { "docs": "Events", "nope": "x" } })));
        let order: Vec<&str> = l["order"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert_eq!(&order[..3], &["docs", "day", "indices"]);
        assert_eq!(order.len(), DAILY_COLUMNS.len());
        assert_eq!(l["hidden"], json!(["topTag"]));
        assert_eq!(l["labels"], json!({ "docs": "Events" }));
        assert_eq!(Core::layout_whole("monthly", None)["hidden"], json!([]));
        assert_eq!(Core::layout_whole("daily", None)["hidden"], json!(DAILY_HIDDEN));
    }
}
