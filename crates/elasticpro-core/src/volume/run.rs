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

use super::collect::{self, IndexFormat, RowResolution};
use super::derive::{self, Totals};
use super::schedule::{self, day_key, month_key, parse_day};
use super::settings::{self, Layers, Source, VolumeSettings};
use super::store::{ClusterState, Store};
use super::{RunState, DAILY_COLUMNS, DAILY_HIDDEN, FIELD_KEYS, MONTHLY_COLUMNS, RUN_EVERY_MS};
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

/// Settings as resolved for one request, with where they came from.
pub(crate) struct Resolved {
    pub settings: VolumeSettings,
    managed: Vec<&'static str>,
    source: Source,
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
}

fn int_arg(msg: &Value, key: &str, default: u64, lo: u64, hi: u64) -> u64 {
    msg.get(key).and_then(Value::as_u64).unwrap_or(default).clamp(lo, hi)
}


impl Core {
    /* ------------------------------------ settings ------------------------------------ */

    /// The clusters file, when this core has one (hosted: ELASTICPRO_CONFIG).
    pub(crate) async fn volume_config(&self) -> Option<Value> {
        self.read_config_file().await.ok()
    }

    /// The settings for one cluster (or the defaults), from the config file when there is
    /// one, else from the message's `volume`, else built-in; config.txt over all of them.
    ///
    /// The message's `volume` counts only on the desktop editions. On hosted the settings
    /// are the config file's — which an admin edits — and a request from anybody else must
    /// not be able to say what the timer's next run counts.
    pub(crate) fn volume_resolve(&self, raw: Option<&Value>, cluster: Option<&str>, msg: Option<&Value>) -> Resolved {
        let from_msg = msg.filter(|_| self.edition() != crate::auth::Edition::Hosted)
            .and_then(|m| m.get("volume")).filter(|v| v.is_object());
        let (layers, source, overrides) = match (raw, from_msg) {
            (Some(raw), _) => (settings::layers_from_config(raw, cluster), Source::File, settings::override_ids(raw)),
            (None, Some(v)) => {
                let ids = v.pointer("/defaults/overrides").and_then(Value::as_object)
                    .map(|o| o.keys().cloned().collect()).unwrap_or_default();
                (settings::layers_from_message(v, cluster), Source::Message, ids)
            }
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
            "VOLUME_MONTHLY_ALL" => return self.volume_monthly_all(msg, caller).await,
            _ => {}
        }
        let raw = self.volume_config().await;
        let id = msg.get("clusterId").and_then(Value::as_str).filter(|s| !s.is_empty());
        if t == "VOLUME_SETTINGS" {
            let r = self.volume_resolve(raw.as_ref(), id, Some(msg));
            let visible = self.visible_ids(caller);
            let overrides: Vec<String> = r.overrides.into_iter().filter(|o| visible.as_ref().is_none_or(|v| v.contains(o))).collect();
            return json!({ "ok": true, "clusterId": id, "settings": r.settings, "managed": r.managed,
                           "source": r.source.as_str(), "overrides": overrides });
        }
        let Some(id) = id else { return bad("bad_request", "clusterId is required") };
        if self.spec_for(id).is_none() {
            return bad("not_found", format!("no cluster {id:?}"));
        }
        let r = self.volume_resolve(raw.as_ref(), Some(id), Some(msg));
        match t {
            "VOLUME_FIELDS_CHECK" => self.volume_fields_check(id, &r.settings, caller).await,
            "VOLUME_DAILY" => self.volume_daily(id, &r.settings, msg),
            "VOLUME_MONTHLY" => self.volume_monthly(id, &r.settings, msg),
            "VOLUME_BREAKDOWN" => self.volume_breakdown(id, msg),
            _ => bad("bad_message", format!("Unknown message type {t:?}")),
        }
    }

    async fn volume_fields_check(self: &Arc<Self>, id: &str, s: &VolumeSettings, caller: Option<&Caller>) -> Value {
        let Some(fmt) = IndexFormat::new(&s.index_format) else { return bad("bad_settings", "indexFormat cannot be used") };
        // A person asked: their class and their name in the request log, not the timer's.
        let ask = |mut r: crate::http::EsRequest| {
            r.class = crate::gate::Class::Interactive;
            r.origin = Some("volume-fields-check".into());
            r.user = caller.map(|c| c.name.clone());
            r.timeout_ms = Some(30_000);
            r
        };
        let cat = self.es_req(ask(collect::cat_request(id, &fmt))).await;
        if cat.get("ok").and_then(Value::as_bool) != Some(true) {
            return cat;
        }
        let listing = collect::read_cat(cat.get("json").unwrap_or(&Value::Null), &fmt);
        let fc = self.es_req(ask(collect::field_caps_request(id, &fmt, s))).await;
        if fc.get("ok").and_then(Value::as_bool) != Some(true) {
            return fc;
        }
        let rows = collect::resolve_rows(fc.get("json").unwrap_or(&Value::Null), s);
        json!({ "ok": true, "clusterId": id, "glob": fmt.glob(),
                "indices": { "match": listing.matched, "days": listing.days.len(), "skipped": listing.skipped,
                             "skippedCount": listing.skipped_count },
                "rows": rows })
    }

    fn volume_daily(&self, id: &str, s: &VolumeSettings, msg: &Value) -> Value {
        let Some(store) = &self.volume.store else { return no_store() };
        let days = int_arg(msg, "days", 30, 14, 400) as i64;
        let avg_days = int_arg(msg, "avgDays", derive::AVG_DAYS_DEFAULT as u64, 3, 180) as u32;
        let source = msg.get("source").and_then(Value::as_str).filter(|s| !s.is_empty());
        let today = schedule::utc_day(now_ms());
        let from = today - Duration::days(days - 1);
        let hist_from = from - Duration::days(avg_days as i64);

        let kept = store.days_between(id, hist_from, today);
        let history = derive::history(&kept, source);
        let window: Vec<&super::Day> = kept.iter().filter(|d| parse_day(&d.day).is_some_and(|x| x >= from)).collect();
        let sources: std::collections::BTreeSet<String> = window.iter().flat_map(|d| d.sources.keys().cloned()).collect();
        let shown: Vec<(&super::Day, Totals)> = window.iter().filter_map(|d| Some((*d, Totals::of(d, source)?))).collect();
        let rows: Vec<Value> = shown.iter()
            .map(|(d, t)| derive::daily_row(d, t, &history, avg_days, s.size_basis, source))
            .collect();
        let totals = derive::window_totals(&shown.iter().map(|(_, t)| t).collect::<Vec<_>>());
        let today_at = window.iter().find(|d| d.day == day_key(today)).map(|d| d.totals_at);
        let st = store.read_state(id);
        json!({
            "ok": true, "clusterId": id, "settings": s, "status": self.volume_status(id, s, &st),
            "cards": derive::cards(&history, today, avg_days, s.size_basis, today_at),
            "days": rows, "totals": totals, "sources": sources, "source": source, "topAvailable": source.is_none(),
            "skipped": st.skipped, "skippedCount": st.skipped_count, "matched": st.matched,
            "window": { "from": day_key(from), "to": day_key(today), "days": days, "avgDays": avg_days },
        })
    }

    fn month_rows(st: &ClusterState, s: &VolumeSettings, months: usize, current: &str) -> Vec<Value> {
        let kept: Vec<_> = st.months.values().filter(|m| m.month.as_str() <= current).collect();
        let skip = kept.len().saturating_sub(months);
        kept.into_iter().skip(skip).map(|m| derive::month_row(m, s.size_basis, current)).collect()
    }

    fn volume_monthly(&self, id: &str, s: &VolumeSettings, msg: &Value) -> Value {
        let Some(store) = &self.volume.store else { return no_store() };
        let months = int_arg(msg, "months", 13, 1, 36) as usize;
        let current = month_key(schedule::utc_day(now_ms()));
        let st = store.read_state(id);
        let rows = Core::month_rows(&st, s, months, &current);
        json!({ "ok": true, "clusterId": id, "status": self.volume_status(id, s, &st),
                "avgPerMonth": derive::avg_per_month(&rows), "months": rows })
    }

    /// Every cluster the caller sees, from `state.json` alone.
    async fn volume_monthly_all(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let Some(store) = &self.volume.store else { return no_store() };
        let months = int_arg(msg, "months", 13, 1, 36) as usize;
        let current = month_key(schedule::utc_day(now_ms()));
        let raw = self.volume_config().await;
        let mut out = vec![];
        for id in self.fleet_visible(caller) {
            let name = self.spec_for(&id).and_then(|s| s.name).unwrap_or_else(|| id.clone());
            let r = self.volume_resolve(raw.as_ref(), Some(&id), Some(msg));
            let st = store.read_state(&id);
            out.push(json!({ "clusterId": id, "name": name, "basis": r.settings.size_basis,
                             "months": Core::month_rows(&st, &r.settings, months, &current) }));
        }
        json!({ "ok": true, "clusters": out })
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

    fn layout_default(table: &str) -> Value {
        let (cols, hidden): (&[&str], &[&str]) = if table == "daily" { (DAILY_COLUMNS, DAILY_HIDDEN) } else { (MONTHLY_COLUMNS, &[]) };
        json!({ "order": cols, "hidden": hidden, "labels": {} })
    }

    /// A stored layout made whole: unknown keys dropped, keys it does not mention appended
    /// in their default order, so a column added in a later version still shows up.
    fn layout_whole(table: &str, stored: Option<&Value>) -> Value {
        let cols: &[&str] = if table == "daily" { DAILY_COLUMNS } else { MONTHLY_COLUMNS };
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
        let labels: Map<String, Value> = v.get("labels").and_then(Value::as_object).into_iter().flatten()
            .filter(|(k, l)| cols.contains(&k.as_str()) && l.is_string()).map(|(k, l)| (k.clone(), l.clone())).collect();
        json!({ "order": order, "hidden": pick("hidden"), "labels": labels })
    }

    pub(crate) fn volume_layouts(&self) -> Value {
        let stored = self.volume.store.as_ref().map(Store::read_layouts).unwrap_or(Value::Null);
        json!({ "daily": Core::layout_whole("daily", stored.get("daily")),
                "monthly": Core::layout_whole("monthly", stored.get("monthly")) })
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
        let cols: &[&str] = match table {
            "daily" => DAILY_COLUMNS,
            "monthly" => MONTHLY_COLUMNS,
            _ => return bad("bad_request", "table must be daily or monthly"),
        };
        let Some(layout) = msg.get("layout").filter(|l| l.is_object()) else { return bad("bad_request", "layout is required") };
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
    /// cluster. Absent ids are every cluster the caller sees.
    async fn volume_run_msg(self: &Arc<Self>, msg: &Value, caller: Option<&Caller>) -> Value {
        if self.volume.store.is_none() {
            return no_store();
        }
        let visible = self.fleet_visible(caller);
        let ids: Vec<String> = match msg.get("clusterIds").and_then(Value::as_array) {
            Some(a) => a.iter().filter_map(Value::as_str).map(String::from).collect(),
            None => visible.clone(),
        };
        let (mut started, mut already, mut too_soon, mut skipped) = (vec![], vec![], vec![], vec![]);
        let stopped = self.volume_stopped();
        let raw = self.volume_config().await;
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
                    let s = self.volume_resolve(raw.as_ref(), Some(&id), Some(msg)).settings;
                    self.volume_spawn(id.clone(), s);
                    started.push(id);
                }
            }
        }
        json!({ "ok": true, "started": started, "already": already, "tooSoon": too_soon,
                "skipped": skipped, "stopped": stopped })
    }

    /// Run one cluster in the background, behind the two-at-once limit. The caller has
    /// already marked it running.
    fn volume_spawn(self: &Arc<Self>, id: String, s: VolumeSettings) {
        let core = self.clone();
        tokio::spawn(async move {
            let permit = core.volume.permits.clone().acquire_owned().await;
            let result = core.volume_run_cluster(&id, &s).await;
            drop(permit);
            if let Err(e) = &result {
                tracing::warn!(cluster = %id, error = %e, "volume daily: run did not finish");
                if let Some(store) = &core.volume.store {
                    let _ = store.update_state(&id, |st| st.last_error = Some(e.clone()));
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
    async fn volume_run_cluster(self: &Arc<Self>, id: &str, s: &VolumeSettings) -> Result<(), String> {
        let stop = || self.volume_stopped().then(|| "the emergency stop came on".to_string());
        let progress = |done, total| self.volume_progress(id, done, total);
        let opts = CollectOpts { origin: "volume-daily", period: None, stop: &stop, progress: &progress };
        self.volume_collect(id, s, &opts).await.map(|_| ())
    }

    /// The collector, for the daily run and for a report job (`report`), under the same
    /// rules: Background class, the emergency stop, one request at a time, finished days
    /// never asked again. A report job passes its `period` — only the months it touches are
    /// refreshed and only its days searched; the run's status and the prune are left to the
    /// daily run — and a `stop` that also answers to `REPORT_STOP`.
    pub(crate) async fn volume_collect(self: &Arc<Self>, id: &str, s: &VolumeSettings, opts: &CollectOpts<'_>) -> Result<Collected, String> {
        let store = self.volume.store.as_ref().ok_or("no data directory")?;
        let fmt = IndexFormat::new(&s.index_format).ok_or("indexFormat cannot be used")?;
        if self.volume_stopped() {
            return Err("the emergency stop is on: nothing was sent".into());
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

        // 1. Sizes per day, from the names.
        let cat = self.es_req(tag(collect::cat_request(id, &fmt))).await;
        if !ok(&cat) {
            let e = format!("_cat/indices: {}", why(&cat));
            if !job {
                store.update_state(id, |st| { st.last_run_at = Some(started); st.last_error = Some(e.clone()); })?;
            }
            out.error = Some(e);
            return Ok(out);
        }
        let listing = collect::read_cat(cat.get("json").unwrap_or(&Value::Null), &fmt);
        drop(cat);

        let mut months: Vec<String> = match opts.period {
            Some((from, to)) => schedule::months_between(from, to),
            None => {
                let mut m = store.months(id);
                m.extend(listing.days.keys().map(|d| month_key(*d)));
                m
            }
        };
        months.sort();
        months.dedup();
        months.retain(|m| *m >= oldest);
        let in_period = |d: NaiveDate| opts.period.is_none_or(|(f, t)| d >= f && d <= t);
        let mut summaries = BTreeMap::new();
        let mut to_search: Vec<NaiveDate> = vec![];
        for m in &months {
            let mut file = store.read_month(id, m);
            if collect::apply_totals(&mut file.days, m, &listing, started) && !file.days.is_empty() {
                store.write_month(id, m, &file)?;
            }
            for (k, d) in &file.days {
                let Some(date) = parse_day(k) else { continue };
                if in_period(date) && collect::needs_search(d, listing.days.get(&date)) {
                    to_search.push(date);
                }
            }
            if !file.days.is_empty() {
                summaries.insert(m.clone(), derive::month_summary(m, &file.days));
            }
        }

        // 2. Which field each row is.
        let rows: Option<Vec<RowResolution>> = if to_search.is_empty() {
            None
        } else {
            let fc = self.es_req(tag(collect::field_caps_request(id, &fmt, s))).await;
            if ok(&fc) {
                Some(collect::resolve_rows(fc.get("json").unwrap_or(&Value::Null), s))
            } else {
                out.error = Some(format!("_field_caps: {}", why(&fc)));
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
                    let res = self.es_req(tag(collect::search_request(id, &fmt, date, &body))).await;
                    if let (Some(day), Some(group)) = (file.days.get_mut(&day_key(date)), listing.days.get(&date)) {
                        if ok(&res) {
                            collect::apply_search(day, res.get("json").unwrap_or(&Value::Null), &rows, group, today, now_ms());
                        } else {
                            let e = why(&res);
                            day.error = Some(e.clone());
                            out.error.get_or_insert_with(|| format!("{}: {e}", day_key(date)));
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
        // keepMonths goes.
        if job {
            store.update_state(id, |st| st.months.extend(summaries))?;
            tracing::info!(cluster = %id, origin = opts.origin, searched = out.searched, error = out.error.as_deref().unwrap_or(""), "volume: days collected for a report");
            return Ok(out);
        }
        let error = out.error.clone();
        store.update_state(id, |st| {
            st.last_run_at = Some(started);
            st.listed_at = Some(started);
            st.last_error = error.clone();
            st.matched = listing.matched;
            st.skipped = listing.skipped.clone();
            st.skipped_count = listing.skipped_count;
            st.months.extend(summaries);
        })?;
        store.prune(id, &oldest)?;
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
        let raw = self.volume_config().await;
        let mut specs = self.all_specs();
        specs.sort_by(|a, b| a.id.cmp(&b.id));
        let mut started = vec![];
        for spec in specs {
            let id = spec.id;
            let s = self.volume_resolve(raw.as_ref(), Some(&id), None).settings;
            let last = store.read_state(&id).last_scheduled_day.as_deref().and_then(parse_day);
            if !schedule::is_due(local, s.collect_time(), last) || self.volume_unreachable(&id) {
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
            // started again by every restart.
            let today = day_key(local.date());
            if store.update_state(&id, |st| st.last_scheduled_day = Some(today.clone())).is_err() {
                if let Some(r) = self.volume.runs.lock().get_mut(&id) {
                    r.running = false;
                }
                continue;
            }
            self.volume_spawn(id.clone(), s);
            started.push(id);
        }
        started
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::volume::schedule::months_between;

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
