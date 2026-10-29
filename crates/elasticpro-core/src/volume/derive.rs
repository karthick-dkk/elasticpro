//! Every figure the pages show, worked out once (docs/VOLUME.md "Derived figures").
//!
//! The UI, the CSV, the .xlsx and the mails all show these answers; none of them does the
//! arithmetic again. Each rule is one function with its own test, because "the average"
//! has meant two different windows in two places in this codebase before.
//!
//! `None` is "not measured" and stays `null` on the wire. A sum over days where some were
//! not measured is the sum of the measured ones; a sum where none were is `None`.

use super::schedule::{day_key, month_key, parse_day};
use super::settings::SizeBasis;
use super::{Day, FIELD_KEYS};
use chrono::{Duration, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// One day's totals, for the whole cluster or one source.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Totals {
    pub indices: u64,
    pub pri_bytes: u64,
    pub total_bytes: u64,
    pub docs: Option<u64>,
    pub event_bytes: Option<u64>,
    pub sub_bytes: Option<u64>,
}

impl Totals {
    pub fn of(d: &Day, source: Option<&str>) -> Option<Totals> {
        match source {
            None => Some(Totals {
                indices: d.indices, pri_bytes: d.pri_bytes, total_bytes: d.total_bytes,
                docs: d.docs, event_bytes: d.event_bytes, sub_bytes: d.sub_bytes,
            }),
            Some(s) => d.sources.get(s).map(|s| Totals {
                indices: s.indices, pri_bytes: s.pri_bytes, total_bytes: s.total_bytes,
                docs: s.docs, event_bytes: s.event_bytes, sub_bytes: s.sub_bytes,
            }),
        }
    }
}

/// The average window when nobody chose one: `VOLUME_DAILY`'s default, the mailed report's
/// "average per day (7)" and the reports' change column.
pub const AVG_DAYS_DEFAULT: u32 = 7;
/// Values per field a breakdown lists when nobody chose: `VOLUME_BREAKDOWN`'s default and
/// the reports' Breakdown sheet.
pub const BREAKDOWN_TOP_DEFAULT: usize = 25;

/// The totals per date of the days given (the whole cluster, or one source where it had
/// indices), for `avg_before`, `daily_row` and `cards`.
pub fn history(days: &[Day], source: Option<&str>) -> BTreeMap<NaiveDate, Totals> {
    days.iter().filter_map(|d| Some((parse_day(&d.day)?, Totals::of(d, source)?))).collect()
}

/// **basis(d)**: what the graph and the cards plot.
pub fn basis(t: &Totals, b: SizeBasis) -> Option<u64> {
    match b {
        SizeBasis::Primary => Some(t.pri_bytes),
        SizeBasis::Total => Some(t.total_bytes),
        SizeBasis::EventSize => t.event_bytes,
    }
}

fn sum_opt(xs: impl Iterator<Item = Option<u64>>) -> Option<u64> {
    xs.fold(None, |acc, x| match (acc, x) {
        (a, None) => a,
        (None, Some(x)) => Some(x),
        (Some(a), Some(x)) => Some(a + x),
    })
}

/// **Average over N days for day d**: the mean of basis over the N calendar days before d
/// that have a record (d itself excluded). `(avg, days it was taken over)`.
pub fn avg_before(days: &BTreeMap<NaiveDate, Totals>, d: NaiveDate, n: u32, b: SizeBasis) -> (Option<f64>, usize) {
    let from = d - Duration::days(n as i64);
    let vals: Vec<u64> = days.range(from..d).filter_map(|(_, t)| basis(t, b)).collect();
    if vals.is_empty() {
        return (None, 0);
    }
    (Some(vals.iter().sum::<u64>() as f64 / vals.len() as f64), vals.len())
}

/// `changeVsAvgPct = (basis(d) − avg) / avg × 100`, `None` when there is no earlier day
/// (or the average is 0: no change can be a percentage of nothing). Two decimals.
pub fn change_vs_avg_pct(v: Option<u64>, avg: Option<f64>) -> Option<f64> {
    let (v, a) = (v? as f64, avg.filter(|a| *a > 0.0)?);
    Some(((v - a) / a * 100.0 * 100.0).round() / 100.0)
}

/// **Top value** of a field on a day: the first `top` entry, share = docs ÷ day docs.
pub fn top_value(d: &Day, key: &str) -> Value {
    let Some(f) = d.fields.get(key).filter(|f| f.error.is_none()) else { return Value::Null };
    let Some(t) = f.top.first() else { return Value::Null };
    let share = d.docs.filter(|n| *n > 0).map(|n| round4(t.docs as f64 / n as f64));
    json!({ "value": t.value, "docs": t.docs, "share": share })
}

fn round4(x: f64) -> f64 {
    (x * 10_000.0).round() / 10_000.0
}

fn avg_bytes(a: Option<f64>) -> Option<u64> {
    a.map(|a| a.round() as u64)
}

/// `DailyRow` = Day totals + basis, avg, changeVsAvgPct, top. Under a source filter the
/// totals are that source's and `top` is not available (all `null`): top values are kept
/// for all sources together.
pub fn daily_row(d: &Day, t: &Totals, history: &BTreeMap<NaiveDate, Totals>, avg_days: u32, b: SizeBasis, source: Option<&str>) -> Value {
    let date = parse_day(&d.day).unwrap_or_default();
    let v = basis(t, b);
    let (avg, _) = avg_before(history, date, avg_days, b);
    let mut top = Map::new();
    for key in FIELD_KEYS {
        top.insert(key.into(), if source.is_some() { Value::Null } else { top_value(d, key) });
    }
    json!({
        "day": d.day, "final": d.is_final, "live": d.live, "aggregatedAt": d.aggregated_at, "totalsAt": d.totals_at,
        "indices": t.indices, "priBytes": t.pri_bytes, "totalBytes": t.total_bytes,
        "docs": t.docs, "eventBytes": t.event_bytes, "subBytes": t.sub_bytes, "error": d.error,
        "basis": v, "avg": avg_bytes(avg), "changeVsAvgPct": change_vs_avg_pct(v, avg),
        "top": top,
    })
}

/// The four cards. `today` is today's UTC date; "finished" days are the ones before it.
///
/// * yesterday's basis;
/// * "Average per day · N days": the mean of the last N finished days, yesterday included
///   — which is `avg_before(today, N)`, the same rule as a row's average, on purpose;
/// * "This month so far": Σ basis of the current month's days, today as of the last run;
/// * "Event bytes · 30 days": Σ eventBytes over the last 30 finished days.
pub fn cards(history: &BTreeMap<NaiveDate, Totals>, today: NaiveDate, avg_days: u32, b: SizeBasis, today_as_of: Option<i64>) -> Value {
    let yesterday = today - Duration::days(1);
    let (avg, n) = avg_before(history, today, avg_days, b);
    // Yesterday against the N days before it: the same rule as its row's "vs N-day avg".
    let yv = history.get(&yesterday).and_then(|t| basis(t, b));
    let (yavg, _) = avg_before(history, yesterday, avg_days, b);
    let month_start = NaiveDate::parse_from_str(&format!("{}-01", month_key(today)), "%Y-%m-%d").unwrap_or(today);
    let month = sum_opt(history.range(month_start..=today).map(|(_, t)| basis(t, b)));
    let ev30: Vec<Option<u64>> = history.range(today - Duration::days(30)..today).map(|(_, t)| t.event_bytes).collect();
    json!({
        "basis": b,
        "yesterday": { "day": day_key(yesterday), "value": yv, "changeVsAvgPct": change_vs_avg_pct(yv, yavg) },
        "average": { "days": avg_days, "daysWithData": n, "value": avg_bytes(avg) },
        "monthSoFar": { "month": month_key(today), "value": month,
                        "asOf": history.contains_key(&today).then_some(today_as_of).flatten() },
        "eventBytes30": { "days": 30, "daysMeasured": ev30.iter().filter(|x| x.is_some()).count(),
                          "value": sum_opt(ev30.into_iter()) },
    })
}

/// The Daily table's totals row: Σ over the days shown. A figure no shown day measured
/// stays `null`; it is not summed to 0.
pub fn window_totals(ts: &[&Totals]) -> Value {
    json!({
        "days": ts.len(),
        "indices": ts.iter().map(|t| t.indices).sum::<u64>(),
        "priBytes": ts.iter().map(|t| t.pri_bytes).sum::<u64>(),
        "totalBytes": ts.iter().map(|t| t.total_bytes).sum::<u64>(),
        "docs": sum_opt(ts.iter().map(|t| t.docs)),
        "eventBytes": sum_opt(ts.iter().map(|t| t.event_bytes)),
        "subBytes": sum_opt(ts.iter().map(|t| t.sub_bytes)),
    })
}

/* --------------------------------------- months --------------------------------------- */

/// The Monthly graph's dashed line: the mean of `basisBytes` over the month rows shown,
/// the current month ("so far") left out because it is not over.
pub fn avg_per_month(rows: &[Value]) -> Option<u64> {
    let vals: Vec<u64> = rows.iter()
        .filter(|r| r["partial"] != json!(true))
        .filter_map(|r| r["basisBytes"].as_u64())
        .collect();
    (!vals.is_empty()).then(|| (vals.iter().sum::<u64>() as f64 / vals.len() as f64).round() as u64)
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peak {
    pub day: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopSum {
    pub value: String,
    pub docs: u64,
}

/// What `state.json` keeps per month, so the Monthly views never open a month file. The
/// peak is kept per basis: the basis is a setting, and changing it must not need a re-run.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthSummary {
    pub month: String,
    pub days_with_data: u64,
    pub live_days: u64,
    pub kept_days: u64,
    /// Days whose event bytes were measured: the divisor for an eventSize average.
    pub event_days: u64,
    pub pri_bytes: u64,
    pub total_bytes: u64,
    pub docs: Option<u64>,
    pub event_bytes: Option<u64>,
    pub sub_bytes: Option<u64>,
    pub peak_primary: Option<Peak>,
    pub peak_total: Option<Peak>,
    pub peak_event_size: Option<Peak>,
    #[serde(default)]
    pub top: BTreeMap<String, Option<TopSum>>,
}

/// Summarise one month's days. Recomputed whenever the month file is written.
pub fn month_summary(month: &str, days: &BTreeMap<String, Day>) -> MonthSummary {
    let mut s = MonthSummary { month: month.into(), ..MonthSummary::default() };
    let peak = |cur: &mut Option<Peak>, day: &str, v: Option<u64>| {
        if let Some(v) = v {
            if cur.as_ref().is_none_or(|p| v > p.bytes) {
                *cur = Some(Peak { day: day.into(), bytes: v });
            }
        }
    };
    let mut by_value: BTreeMap<&str, BTreeMap<String, u64>> = BTreeMap::new();
    for d in days.values() {
        s.days_with_data += 1;
        if d.live { s.live_days += 1 } else { s.kept_days += 1 }
        s.event_days += d.event_bytes.is_some() as u64;
        s.pri_bytes += d.pri_bytes;
        s.total_bytes += d.total_bytes;
        s.docs = sum_opt([s.docs, d.docs].into_iter());
        s.event_bytes = sum_opt([s.event_bytes, d.event_bytes].into_iter());
        s.sub_bytes = sum_opt([s.sub_bytes, d.sub_bytes].into_iter());
        peak(&mut s.peak_primary, &d.day, Some(d.pri_bytes));
        peak(&mut s.peak_total, &d.day, Some(d.total_bytes));
        peak(&mut s.peak_event_size, &d.day, d.event_bytes);
        for key in FIELD_KEYS {
            let Some(f) = d.fields.get(key).filter(|f| f.error.is_none()) else { continue };
            let m = by_value.entry(key).or_default();
            for t in &f.top {
                *m.entry(t.value.clone()).or_default() += t.docs;
            }
        }
    }
    for key in FIELD_KEYS {
        // By summed docs; on a tie, the value that sorts first, so the answer is stable.
        let best = by_value.get(key).and_then(|m| m.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0))))
            .map(|(v, n)| TopSum { value: v.clone(), docs: *n });
        s.top.insert(key.into(), best);
    }
    s
}

/// **Month row**, under the basis in force now.
pub fn month_row(s: &MonthSummary, b: SizeBasis, current_month: &str) -> Value {
    let (sum, divisor, peak) = match b {
        SizeBasis::Primary => (Some(s.pri_bytes), s.days_with_data, &s.peak_primary),
        SizeBasis::Total => (Some(s.total_bytes), s.days_with_data, &s.peak_total),
        SizeBasis::EventSize => (s.event_bytes, s.event_days, &s.peak_event_size),
    };
    let avg = sum.filter(|_| divisor > 0).map(|x| (x as f64 / divisor as f64).round() as u64);
    let mut top = Map::new();
    for key in FIELD_KEYS {
        let t = s.top.get(key).cloned().flatten();
        top.insert(key.into(), match t {
            None => Value::Null,
            Some(t) => {
                let share = s.docs.filter(|n| *n > 0).map(|n| round4(t.docs as f64 / n as f64));
                json!({ "value": t.value, "docs": t.docs, "share": share })
            }
        });
    }
    json!({
        "month": s.month, "daysWithData": s.days_with_data, "partial": s.month == current_month,
        "priBytes": s.pri_bytes, "totalBytes": s.total_bytes, "docs": s.docs,
        "eventBytes": s.event_bytes, "subBytes": s.sub_bytes,
        "basis": b, "basisBytes": sum, "avgPerDay": avg, "peakDay": peak,
        "liveDays": s.live_days, "keptDays": s.kept_days, "top": top,
    })
}

/* -------------------------------------- breakdown -------------------------------------- */

#[derive(Default)]
struct Acc {
    docs: u64,
    event: Option<u64>,
    est: f64,
    days: u64,
}

/// **Breakdown** of one field over `[from, to]`: per value Σ docs, Σ eventBytes (measured),
/// Σ estimated primary — Σ over days of (value docs ÷ day docs) × day primary size —, its
/// share of the estimated total, and the days it was seen. "(not set)" (missing) and
/// "all others" (other) are rows too, and count. Values beyond `top` are folded into
/// "all others".
pub fn breakdown(days: &[&Day], key: &str, top: usize) -> Value {
    let mut values: BTreeMap<String, Acc> = BTreeMap::new();
    let (mut missing, mut other) = (Acc::default(), Acc::default());
    let (mut total_docs, mut total_pri, mut measured_days) = (0u64, 0u64, 0u64);
    let mut fields: Vec<String> = vec![];
    let mut error: Option<String> = None;
    let add = |a: &mut Acc, docs: u64, ev: Option<u64>, day_docs: u64, pri: u64| {
        a.docs += docs;
        a.event = sum_opt([a.event, ev].into_iter());
        a.est += docs as f64 / day_docs as f64 * pri as f64;
        a.days += (docs > 0) as u64;
    };
    for d in days {
        let Some(f) = d.fields.get(key) else { continue };
        if let Some(e) = &f.error {
            error.get_or_insert_with(|| e.clone());
            continue;
        }
        let Some(day_docs) = d.docs.filter(|n| *n > 0) else { continue };
        if let Some(name) = &f.field {
            if !fields.contains(name) {
                fields.push(name.clone());
            }
        }
        measured_days += 1;
        total_docs += day_docs;
        total_pri += d.pri_bytes;
        for t in &f.top {
            add(values.entry(t.value.clone()).or_default(), t.docs, t.event_bytes, day_docs, d.pri_bytes);
        }
        add(&mut missing, f.missing_docs, f.missing_event_bytes, day_docs, d.pri_bytes);
        add(&mut other, f.other_docs, f.other_event_bytes, day_docs, d.pri_bytes);
    }
    let mut ranked: Vec<(String, Acc)> = values.into_iter().collect();
    ranked.sort_by(|a, b| b.1.docs.cmp(&a.1.docs).then(a.0.cmp(&b.0)));
    let keep = top.min(ranked.len());
    for (_, a) in ranked.drain(keep..) {
        other.docs += a.docs;
        other.event = sum_opt([other.event, a.event].into_iter());
        other.est += a.est;
        other.days = other.days.max(a.days);
    }
    let est_total: f64 = ranked.iter().map(|(_, a)| a.est).sum::<f64>() + missing.est + other.est;
    let row = |value: &str, kind: &str, a: &Acc| json!({
        "value": value, "kind": kind, "docs": a.docs, "eventBytes": a.event,
        "estPriBytes": a.est.round() as u64,
        "sharePct": (est_total > 0.0).then(|| (a.est / est_total * 100.0 * 100.0).round() / 100.0),
        "daysSeen": a.days,
    });
    let mut rows: Vec<Value> = ranked.iter().map(|(v, a)| row(v, "value", a)).collect();
    rows.push(row("(not set)", "missing", &missing));
    rows.push(row("all others", "other", &other));
    let mut out = json!({
        "field": key, "resolved": fields.last(), "resolvedAll": fields, "rows": rows,
        "totals": { "docs": total_docs, "priBytes": total_pri, "estPriBytes": est_total.round() as u64, "days": measured_days },
    });
    if measured_days == 0 {
        out["error"] = json!(error.unwrap_or_else(|| "no aggregated day in this period".into()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::volume::{FieldAgg, TopValue};

    fn d(s: &str) -> NaiveDate {
        parse_day(s).unwrap()
    }
    fn t(pri: u64, ev: Option<u64>) -> Totals {
        Totals { indices: 1, pri_bytes: pri, total_bytes: pri * 2, docs: Some(pri / 10), event_bytes: ev, sub_bytes: None }
    }
    fn hist(rows: &[(&str, u64, Option<u64>)]) -> BTreeMap<NaiveDate, Totals> {
        rows.iter().map(|(k, p, e)| (d(k), t(*p, *e))).collect()
    }

    #[test]
    fn basis_follows_the_setting_and_event_size_may_be_unmeasured() {
        let x = t(100, None);
        assert_eq!(basis(&x, SizeBasis::Primary), Some(100));
        assert_eq!(basis(&x, SizeBasis::Total), Some(200));
        assert_eq!(basis(&x, SizeBasis::EventSize), None);
    }

    #[test]
    fn the_average_is_over_calendar_days_before_d_that_have_a_record() {
        // 3-day window before the 20th: 17, 18, 19. The 18th has no record; the 20th is d.
        let h = hist(&[("2026-10-16", 1000, None), ("2026-10-17", 100, None), ("2026-10-19", 300, None), ("2026-10-20", 999, None)]);
        assert_eq!(avg_before(&h, d("2026-10-20"), 3, SizeBasis::Primary), (Some(200.0), 2));
        assert_eq!(avg_before(&h, d("2026-10-16"), 3, SizeBasis::Primary), (None, 0), "no earlier day");
        assert_eq!(change_vs_avg_pct(Some(300), Some(200.0)), Some(50.0));
        assert_eq!(change_vs_avg_pct(Some(100), Some(300.0)), Some(-66.67));
        assert_eq!(change_vs_avg_pct(Some(100), None), None);
        assert_eq!(change_vs_avg_pct(None, Some(1.0)), None);
        assert_eq!(change_vs_avg_pct(Some(1), Some(0.0)), None);
        // Unmeasured event bytes are left out of the mean, not counted as 0.
        let e = hist(&[("2026-10-18", 1, Some(10)), ("2026-10-19", 1, None)]);
        assert_eq!(avg_before(&e, d("2026-10-20"), 7, SizeBasis::EventSize), (Some(10.0), 1));
    }

    #[test]
    fn cards() {
        let h = hist(&[
            ("2026-09-29", 50, Some(5)), // 30 days before the 29th: inside the event window
            ("2026-09-28", 70, Some(7)), // 31 days: outside
            ("2026-10-01", 100, Some(1)),
            ("2026-10-27", 200, None),
            ("2026-10-28", 400, Some(40)),
            ("2026-10-29", 1000, Some(100)), // today, as of the last run
        ]);
        let c = super::cards(&h, d("2026-10-29"), 3, SizeBasis::Primary, Some(123));
        assert_eq!(c["yesterday"], json!({ "day": "2026-10-28", "value": 400, "changeVsAvgPct": 100.0 }),
                   "against the 25th..27th: only the 27th (200) has a record");
        assert_eq!(c["average"], json!({ "days": 3, "daysWithData": 2, "value": 300 }), "26th, 27th, 28th: two with a record");
        assert_eq!(c["monthSoFar"], json!({ "month": "2026-10", "value": 1700, "asOf": 123 }), "today included");
        assert_eq!(c["eventBytes30"]["value"], 46, "29 Sep .. 28 Oct, measured only; today excluded");
        assert_eq!(c["eventBytes30"]["daysMeasured"], 3);
        let none = super::cards(&hist(&[("2026-10-28", 1, None)]), d("2026-10-29"), 7, SizeBasis::EventSize, None);
        assert_eq!(none["eventBytes30"]["value"], Value::Null, "nothing measured is null, not 0");
        assert_eq!(none["yesterday"]["value"], Value::Null);
        assert_eq!(none["monthSoFar"]["value"], Value::Null);
        assert_eq!(none["yesterday"]["changeVsAvgPct"], Value::Null, "no earlier day, no change");
    }

    #[test]
    fn window_totals_keep_unmeasured_null() {
        let a = Totals { indices: 2, pri_bytes: 10, total_bytes: 20, docs: Some(5), event_bytes: None, sub_bytes: None };
        let b = Totals { indices: 1, pri_bytes: 1, total_bytes: 2, docs: None, event_bytes: Some(7), sub_bytes: None };
        let t = super::window_totals(&[&a, &b]);
        assert_eq!(t, json!({ "days": 2, "indices": 3, "priBytes": 11, "totalBytes": 22,
                              "docs": 5, "eventBytes": 7, "subBytes": null }));
    }

    #[test]
    fn avg_per_month_leaves_the_current_month_out() {
        let rows = [json!({ "partial": false, "basisBytes": 300 }), json!({ "partial": false, "basisBytes": null }),
                    json!({ "partial": false, "basisBytes": 100 }), json!({ "partial": true, "basisBytes": 5000 })];
        assert_eq!(super::avg_per_month(&rows), Some(200));
        assert_eq!(super::avg_per_month(&rows[3..]), None, "only the month so far: no average");
    }

    fn day(k: &str, pri: u64, docs: Option<u64>, live: bool, tag: &[(&str, u64)], missing: u64, other: u64) -> Day {
        let mut x = Day { day: k.into(), live, pri_bytes: pri, total_bytes: pri * 2, docs, event_bytes: docs.map(|n| n * 2), ..Day::default() };
        x.fields.insert("tag".into(), FieldAgg {
            field: Some("tag1".into()),
            top: tag.iter().map(|(v, n)| TopValue { value: v.to_string(), docs: *n, event_bytes: Some(n * 2), sub_bytes: None }).collect(),
            missing_docs: missing, other_docs: other, missing_event_bytes: Some(missing * 2), other_event_bytes: Some(other * 2),
            ..FieldAgg::default()
        });
        x.fields.insert("sourceHost".into(), FieldAgg { error: Some("src_hostname: not in the mapping".into()), ..FieldAgg::default() });
        x
    }

    #[test]
    fn top_value_and_daily_row() {
        let x = day("2026-10-20", 1000, Some(100), true, &[("fw", 60), ("px", 30)], 10, 0);
        assert_eq!(top_value(&x, "tag"), json!({ "value": "fw", "docs": 60, "share": 0.6 }));
        assert_eq!(top_value(&x, "sourceHost"), Value::Null, "an unresolved field has no top value");
        let h = hist(&[("2026-10-19", 500, None)]);
        let r = daily_row(&x, &Totals::of(&x, None).unwrap(), &h, 7, SizeBasis::Primary, None);
        assert_eq!((r["basis"].as_u64(), r["avg"].as_u64(), r["changeVsAvgPct"].as_f64()), (Some(1000), Some(500), Some(100.0)));
        assert_eq!(r["top"]["tag"]["value"], "fw");
        let r = daily_row(&x, &Totals::of(&x, None).unwrap(), &h, 7, SizeBasis::Primary, Some("linux"));
        assert_eq!(r["top"]["tag"], Value::Null, "under a source filter top values are not available");
    }

    #[test]
    fn month_summary_and_row() {
        let mut days = BTreeMap::new();
        for x in [
            day("2026-10-01", 100, Some(10), false, &[("fw", 8)], 2, 0),
            day("2026-10-02", 300, Some(30), true, &[("px", 20), ("fw", 5)], 5, 0),
            day("2026-10-03", 200, None, true, &[], 0, 0),
        ] {
            days.insert(x.day.clone(), x);
        }
        let s = month_summary("2026-10", &days);
        assert_eq!((s.days_with_data, s.live_days, s.kept_days), (3, 2, 1));
        assert_eq!((s.pri_bytes, s.docs, s.event_bytes), (600, Some(40), Some(80)));
        assert_eq!(s.peak_primary, Some(Peak { day: "2026-10-02".into(), bytes: 300 }));
        assert_eq!(s.top["tag"], Some(TopSum { value: "px".into(), docs: 20 }), "by summed docs: px 20 > fw 13");
        assert_eq!(s.top["sourceHost"], None);
        let r = month_row(&s, SizeBasis::Primary, "2026-10");
        assert_eq!(r["avgPerDay"], 200, "Σ basis ÷ daysWithData");
        assert_eq!(r["partial"], true);
        assert_eq!(r["peakDay"], json!({ "day": "2026-10-02", "bytes": 300 }));
        assert_eq!(r["top"]["tag"]["share"], 0.5);
        let r = month_row(&s, SizeBasis::EventSize, "2026-11");
        assert_eq!(r["avgPerDay"], 40, "event bytes over the two days they were measured");
        assert_eq!(r["partial"], false);
    }

    #[test]
    fn breakdown_estimates_primary_per_value_and_lists_missing_and_other() {
        let a = day("2026-10-01", 1000, Some(100), true, &[("fw", 50), ("px", 40)], 10, 0);
        let b = day("2026-10-02", 2000, Some(100), true, &[("fw", 100)], 0, 0);
        let skipped = day("2026-10-03", 5000, None, true, &[("zz", 1)], 0, 0);
        let r = breakdown(&[&a, &b, &skipped], "tag", 25);
        let rows = r["rows"].as_array().unwrap();
        assert_eq!(rows[0]["value"], "fw");
        assert_eq!(rows[0]["docs"], 150);
        assert_eq!(rows[0]["eventBytes"], 300);
        assert_eq!(rows[0]["estPriBytes"], 2500, "50/100×1000 + 100/100×2000");
        assert_eq!(rows[0]["daysSeen"], 2);
        assert_eq!(rows[1]["estPriBytes"], 400);
        let missing = rows.iter().find(|r| r["kind"] == "missing").unwrap();
        assert_eq!((missing["value"].as_str(), missing["docs"].as_u64(), missing["estPriBytes"].as_u64()), (Some("(not set)"), Some(10), Some(100)));
        assert_eq!(r["totals"]["estPriBytes"], 3000, "the estimate adds up to the measured primary size");
        assert_eq!(rows[0]["sharePct"], 83.33);
        assert_eq!(r["resolved"], "tag1");
        // Top 1: px folds into "all others".
        let r1 = breakdown(&[&a, &b], "tag", 1);
        let other = r1["rows"].as_array().unwrap().iter().find(|r| r["kind"] == "other").unwrap().clone();
        assert_eq!(other["docs"], 40);
        // A field that never resolved says so instead of a table of zeroes.
        let e = breakdown(&[&a], "sourceHost", 25);
        assert!(e["error"].as_str().unwrap().contains("not in the mapping"), "{e}");
    }
}
