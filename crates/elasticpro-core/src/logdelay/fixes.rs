//! Recommended fixes: plain rules over the stored delay periods and the cluster facts
//! ElasticPro already reads (docs/LOGDELAY.md "Recommended fixes"; the Fix board).
//!
//! No model, no guess. Each rule names the step on a log's path it points to, and a match
//! becomes one finding with the devices, one line of why, one line of fix and the numbers it
//! was read from. A device nothing matches gets "not enough evidence", with what would let
//! the next run decide (a missing `fwd_tag`, more measurements).
//!
//! | pattern | step |
//! |---|---|
//! | many devices late in the same windows, across forwarders | Elasticsearch |
//! | late devices share one `fwd_tag` (or `Zone`), others there on time | Forwarder |
//! | late devices share one `parser_tag`, across forwarders | Parser |
//! | steady whole-hour offset, or negative | Device clock |
//! | a silence, then a burst of old logs | Device link |
//! | nothing above | not enough evidence |

use super::levels::State;
use super::state::{Episode, Silence, Tracker};
use super::time;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// Where on the path a finding points.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Step {
    Elasticsearch,
    Forwarder,
    Parser,
    DeviceClock,
    DeviceLink,
    Unknown,
}

impl Step {
    pub fn label(self) -> &'static str {
        match self {
            Step::Elasticsearch => "Elasticsearch",
            Step::Forwarder => "Forwarder",
            Step::Parser => "Parser",
            Step::DeviceClock => "Device clock",
            Step::DeviceLink => "Device link",
            Step::Unknown => "Not enough evidence",
        }
    }
}

/// One recommendation: a group's, or one device's.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub cluster: String,
    pub step: Step,
    pub devices: Vec<String>,
    /// The column and value the group shares, when it is a group by a column.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<(String, String)>,
    pub why: String,
    pub fix: String,
    pub evidence: Value,
    /// Inputs the rule could not read: named, never assumed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<String>,
}

/// What ElasticPro already knows about the cluster, from the fleet cache. Every figure is
/// optional: a dataset the poller has not read is unknown, and the finding says so.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterFacts {
    /// Write thread-pool rejections, summed over nodes, as last read.
    pub write_rejected: Option<u64>,
    /// Data nodes at or over the high disk watermark, as last read.
    pub nodes_over_watermark: Option<u64>,
    /// Snapshots that ran in the range: `(start_ms, end_ms, name)`.
    pub snapshots: Vec<(i64, i64, String)>,
    /// Whether the snapshot list could be read at all.
    pub snapshots_known: bool,
}

/// How many measured devices make "many" in one window: a fifth of them, and never fewer
/// than five.
pub fn many(measured: usize) -> usize {
    (measured / 5).max(5)
}

/// The findings for one cluster over `[from, to)`. `every_ms` is the measurement interval.
pub fn findings(cluster: &str, t: &Tracker, from: i64, to: i64, now: i64, every_ms: i64, facts: &ClusterFacts) -> Vec<Finding> {
    let episodes: Vec<Episode> = t.all_episodes().into_iter()
        .filter(|e| e.started_ms < to && e.end_ms(now) >= from).collect();
    if episodes.is_empty() {
        return vec![];
    }
    let late_devices: BTreeSet<String> = episodes.iter().map(|e| e.device.clone()).collect();
    let mut out = vec![];
    let mut claimed: BTreeSet<String> = BTreeSet::new();
    let measured = t.devices.len().max(late_devices.len());
    let extras_of = |d: &str| t.devices.get(d).map(|x| x.extras.clone()).unwrap_or_default();
    let have = |col: &str| t.devices.values().any(|d| d.extras.contains_key(col));

    // 1. Elasticsearch: the same windows, many devices, more than one forwarder.
    {
        let step = every_ms.max(1);
        let mut by_window: BTreeMap<i64, BTreeSet<String>> = BTreeMap::new();
        for e in &episodes {
            let end = e.end_ms(now).min(to);
            let mut w = (e.started_ms.max(from) / step) * step;
            while w < end {
                by_window.entry(w).or_default().insert(e.device.clone());
                w += step;
            }
        }
        let busy: Vec<(i64, BTreeSet<String>)> = by_window.into_iter().filter(|(_, d)| d.len() >= many(measured)).collect();
        if !busy.is_empty() {
            let devices: BTreeSet<String> = busy.iter().flat_map(|(_, d)| d.iter().cloned()).collect();
            let fwds: BTreeSet<String> = devices.iter().filter_map(|d| extras_of(d).get("fwd_tag").cloned()).collect();
            let across = fwds.len() >= 2 || !have("fwd_tag");
            if across {
                let mut hours: BTreeMap<u32, usize> = BTreeMap::new();
                let mut days: BTreeSet<String> = BTreeSet::new();
                for (w, _) in &busy {
                    use chrono::Timelike;
                    *hours.entry(time::local_datetime(*w).hour()).or_default() += 1;
                    days.insert(time::local_day_key(*w));
                }
                let (h0, h1) = (hours.keys().min().copied().unwrap_or(0), hours.keys().max().copied().unwrap_or(0));
                let window_text = format!("{h0:02}:00–{:02}:00", (h1 + (every_ms / 3_600_000).max(1) as u32).min(24));
                let in_peak = facts.snapshots.iter().filter(|(s, e, _)| busy.iter().any(|(w, _)| *s < w + step && *e > *w)).collect::<Vec<_>>();
                let mut why = format!("the cluster could not index fast enough {window_text}, so devices on it fell behind together");
                let mut fix = String::from("add indexing capacity before the window, or move batch work out of it");
                if let Some((s, _, name)) = in_peak.first() {
                    why = format!("the cluster could not index fast enough {window_text}; a snapshot ({name}) was running in that window");
                    fix = format!("move the snapshot {name} (starts {}) out of the window, or add indexing capacity before it", time::hhmm(*s));
                }
                if facts.nodes_over_watermark.is_some_and(|n| n > 0) {
                    fix = format!("{fix}; free disk — {} data node(s) at the high watermark", facts.nodes_over_watermark.unwrap_or(0));
                }
                let mut missing = vec![];
                if facts.write_rejected.is_none() {
                    missing.push("write thread-pool rejections (fleet cache: Shards dataset not read yet)".to_string());
                }
                if !facts.snapshots_known {
                    missing.push("snapshot times (fleet cache: Policies dataset not read yet)".to_string());
                }
                if facts.nodes_over_watermark.is_none() {
                    missing.push("disk watermark (fleet cache: Nodes or Policies dataset not read yet)".to_string());
                }
                if !have("fwd_tag") {
                    missing.push("fwd_tag on these devices: \"across forwarders\" could not be checked".to_string());
                }
                out.push(Finding {
                    cluster: cluster.into(), step: Step::Elasticsearch, devices: devices.iter().cloned().collect(), group: None, why, fix,
                    evidence: json!({
                        "devicesLate": devices.len(), "devicesMeasured": measured, "windows": busy.len(), "days": days.len(),
                        "window": window_text, "forwarders": fwds.len(), "writeRejected": facts.write_rejected,
                        "nodesOverWatermark": facts.nodes_over_watermark,
                        "snapshotsInWindow": in_peak.iter().map(|(s, e, n)| json!({ "name": n, "from": s, "to": e })).collect::<Vec<_>>(),
                    }),
                    missing,
                });
                claimed.extend(devices);
            }
        }
    }

    // 2/3. One forwarder (fwd_tag, else Zone), one parser.
    for (col, step) in [("fwd_tag", Step::Forwarder), ("Zone", Step::Forwarder), ("parser_tag", Step::Parser)] {
        if col == "Zone" && have("fwd_tag") {
            continue; // Zone stands in for fwd_tag only when there is no fwd_tag at all
        }
        if !have(col) {
            continue;
        }
        let mut groups: BTreeMap<String, (BTreeSet<String>, BTreeSet<String>)> = BTreeMap::new(); // value → (all, late)
        for (name, d) in &t.devices {
            if let Some(v) = d.extras.get(col) {
                let g = groups.entry(v.clone()).or_default();
                g.0.insert(name.clone());
                if late_devices.contains(name) && !claimed.contains(name) {
                    g.1.insert(name.clone());
                }
            }
        }
        for (value, (all, late)) in &groups {
            if late.len() < 2 || late.len() * 2 < all.len() {
                continue; // at least two late, and at least half of that group
            }
            // The others on the same column must exist and be mostly on time: with nobody else
            // to compare against, "others were on time" cannot be said, so nothing is claimed.
            let (others_all, others_late): (usize, usize) = groups.iter().filter(|(v, _)| *v != value)
                .fold((0, 0), |(a, l), (_, g)| (a + g.0.len(), l + g.1.len()));
            if others_all == 0 || others_late * 5 > others_all {
                continue;
            }
            let mut missing = vec![];
            if step == Step::Parser {
                let fwds: BTreeSet<String> = late.iter().filter_map(|d| extras_of(d).get("fwd_tag").cloned()).collect();
                if have("fwd_tag") && fwds.len() < 2 {
                    continue; // one forwarder's devices: the forwarder rule has it
                }
                if !have("fwd_tag") {
                    missing.push("fwd_tag on these devices: \"across forwarders\" could not be checked, this may be one forwarder".to_string());
                }
            }
            let (why, fix) = match step {
                Step::Forwarder => (
                    format!("one forwarder is holding logs back ({col} {value}); devices on the other {col}s were on time at the same moments"),
                    format!("check {value}: its queue or disk buffer, and the link to Logstash"),
                ),
                _ => (
                    format!("one parsing pipeline is slow ({col} {value}), so only devices it handles are late"),
                    format!("look at the {value} filter in Logstash (a heavy grok pattern or a slow lookup); give that pipeline its own workers"),
                ),
            };
            let queue_shape = episodes.iter().filter(|e| late.contains(&e.device) && e.solved_ms.is_some() && e.worst_minutes >= e.last_minutes + 20.0).count();
            out.push(Finding {
                cluster: cluster.into(), step, devices: late.iter().cloned().collect(), group: Some((col.to_string(), value.clone())), why, fix,
                evidence: json!({ "sharing": late.len(), "ofGroup": all.len(), "othersLate": others_late, "othersAll": others_all,
                                  "dropAtOnce": queue_shape }),
                missing,
            });
            claimed.extend(late.iter().cloned());
        }
    }

    // 4. Device clock: a steady whole-hour offset, or a clock ahead.
    {
        let mut tz: Vec<(String, u32, u32)> = vec![];
        for d in &late_devices {
            if claimed.contains(d) {
                continue;
            }
            let (mut whole, mut n) = (0u32, 0u32);
            for e in episodes.iter().filter(|e| &e.device == d) {
                whole += e.whole_hour;
                n += e.measurements;
            }
            let ahead = t.devices.get(d).is_some_and(|x| x.state == State::ClockAhead || x.recent.iter().filter(|p| p.s == State::ClockAhead).count() >= 2);
            if (n >= 2 && whole * 10 >= n * 8) || ahead {
                tz.push((d.clone(), whole, n));
            }
        }
        if !tz.is_empty() {
            let devices: Vec<String> = tz.iter().map(|(d, _, _)| d.clone()).collect();
            let (w, n) = tz.iter().fold((0, 0), |(a, b), (_, w, n)| (a + w, b + n));
            out.push(Finding {
                cluster: cluster.into(), step: Step::DeviceClock, devices: devices.clone(), group: None,
                why: "the device's clock or time zone is wrong: the delay sits at a whole hour (or runs ahead) every time, which a real backlog never does".into(),
                fix: "set the device to the right time zone and to NTP; no log is actually late".into(),
                evidence: json!({ "wholeHourMeasurements": w, "measurements": n,
                                  "share": if n > 0 { Some(((w as f64 / n as f64) * 100.0).round()) } else { None } }),
                missing: vec![],
            });
            claimed.extend(devices);
        }
    }

    // 5. Device link: silent, then a burst of old logs.
    {
        let silences: Vec<&Silence> = t.silences.iter().chain(t.open_silences())
            .filter(|s| s.from_ms < to && s.to_ms.unwrap_or(now) >= from).collect();
        let mut hits: Vec<(String, &Silence)> = vec![];
        for s in silences {
            if claimed.contains(&s.device) {
                continue;
            }
            let came_back_late = s.burst_minutes.is_some_and(|m| m >= 30.0);
            if came_back_late && late_devices.contains(&s.device) {
                hits.push((s.device.clone(), s));
            }
        }
        for (d, s) in hits {
            out.push(Finding {
                cluster: cluster.into(), step: Step::DeviceLink, devices: vec![d.clone()], group: None,
                why: format!("the device stopped sending, then sent its buffer in one go; the delay is the gap, not a slow path (silent from {})", time::when(s.from_ms, now)),
                fix: format!("check the device's connection to its forwarder around {}", time::hhmm(s.from_ms)),
                evidence: json!({ "silentFrom": s.from_ms, "silentTo": s.to_ms, "burstDocs": s.burst_docs, "burstMinutes": s.burst_minutes }),
                missing: vec![],
            });
            claimed.insert(d);
        }
    }

    // 6. The rest: not known yet, with what would let the next run decide.
    let rest: Vec<String> = late_devices.iter().filter(|d| !claimed.contains(*d)).cloned().collect();
    if !rest.is_empty() {
        let mut missing = vec![];
        for col in ["fwd_tag", "parser_tag"] {
            if rest.iter().any(|d| !extras_of(d).contains_key(col)) {
                missing.push(format!("{col} on these devices' logs"));
            }
        }
        let few = rest.iter().filter(|d| episodes.iter().filter(|e| &e.device == *d).map(|e| e.measurements).sum::<u32>() < 3).count();
        if few > 0 {
            missing.push(format!("more measurements ({few} device(s) measured late fewer than three times)"));
        }
        out.push(Finding {
            cluster: cluster.into(), step: Step::Unknown, devices: rest.clone(), group: None,
            why: "late, but no pattern matches; shown as is, nothing is guessed".into(),
            fix: if missing.is_empty() { "more measurements would let the next run decide".into() }
                 else { format!("{} would let the next run decide", missing.join(" and ")) },
            evidence: json!({ "devices": rest.len() }),
            missing,
        });
    }
    out.sort_by_key(|f| std::cmp::Reverse(f.devices.len()));
    out
}

/// Each device's own line, keyed by `(cluster, device)` — the same hostname may send to two
/// clusters: the first group finding it is in, in the order the groups came.
pub fn per_device(findings: &[Finding]) -> BTreeMap<(String, String), Finding> {
    let mut out = BTreeMap::new();
    for f in findings {
        for d in &f.devices {
            out.entry((f.cluster.clone(), d.clone())).or_insert_with(|| Finding { devices: vec![d.clone()], ..f.clone() });
        }
    }
    out
}

/// What the fleet cache holds about one cluster, read into facts. `shards`, `policies` and
/// `nodes` are the cached bodies (`Entry.data`), or `None` when not read yet.
pub fn facts_from_cache(shards: Option<&Value>, policies: Option<&Value>, nodes: Option<&Value>, from: i64, to: i64) -> ClusterFacts {
    let mut f = ClusterFacts::default();
    if let Some(rows) = shards.and_then(|s| s.pointer("/threadPools/json")).and_then(Value::as_array) {
        f.write_rejected = Some(rows.iter().filter(|r| r.get("name").and_then(Value::as_str) == Some("write"))
            .map(|r| r.get("rejected").and_then(|v| v.as_str().and_then(|s| s.parse::<u64>().ok()).or_else(|| v.as_u64())).unwrap_or(0)).sum());
    }
    if let Some(p) = policies {
        if let Some(slm) = p.pointer("/slm/json").and_then(Value::as_object) {
            f.snapshots_known = true;
            for (name, pol) in slm {
                let start = pol.pointer("/last_success/start_time_millis").and_then(Value::as_i64)
                    .or_else(|| pol.pointer("/last_success/start_time").and_then(Value::as_str).and_then(crate::delay_sink::parse_rfc3339_ms));
                let end = pol.pointer("/last_success/time").and_then(Value::as_i64)
                    .or_else(|| pol.pointer("/last_success/time_string").and_then(Value::as_str).and_then(crate::delay_sink::parse_rfc3339_ms));
                if let (Some(s), Some(e)) = (start, end) {
                    if s < to && e >= from {
                        f.snapshots.push((s, e, name.clone()));
                    }
                }
            }
        }
        let high = p.pointer("/clusterSettings/json").and_then(|cs| ["persistent", "transient", "defaults"].iter()
            .find_map(|k| cs.get(k).and_then(|o| o.get("cluster.routing.allocation.disk.watermark.high")).and_then(Value::as_str).map(String::from)));
        let pct = high.as_deref().and_then(|h| h.trim().strip_suffix('%')).and_then(|p| p.trim().parse::<f64>().ok());
        if let (Some(pct), Some(alloc)) = (pct, nodes.and_then(|n| n.pointer("/alloc/json")).and_then(Value::as_array)) {
            f.nodes_over_watermark = Some(alloc.iter().filter(|r| {
                r.get("disk.percent").and_then(|v| v.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| v.as_f64())).is_some_and(|u| u >= pct)
            }).count() as u64);
        }
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logdelay::levels::Levels;
    use crate::logdelay::measure::Reading;

    const H: i64 = 3_600_000;

    fn reading(device: &str, m: Option<f64>, run: i64, fwd: &str, parser: &str) -> Reading {
        let mut extras = BTreeMap::new();
        if !fwd.is_empty() {
            extras.insert("fwd_tag".into(), fwd.into());
        }
        if !parser.is_empty() {
            extras.insert("parser_tag".into(), parser.into());
        }
        Reading { device: device.into(), docs: 100, arrival_ms: Some(run), event_ms: m.map(|x| run - (x * 60_000.0) as i64), delay_minutes: m, extras }
    }

    fn run(t: &mut Tracker, at: i64, rs: Vec<Reading>) {
        t.apply(at, rs, &Levels::default(), 2 * H);
    }

    #[test]
    fn one_forwarder_late_while_the_others_are_fine_is_the_forwarder() {
        let mut t = Tracker::default();
        for i in 0..3 {
            let at = i * 2 * H;
            let mut rs = vec![];
            for n in 0..4 {
                rs.push(reading(&format!("a-{n}"), Some(50.0), at, "syslog-1", "grok"));
            }
            for n in 0..6 {
                rs.push(reading(&format!("b-{n}"), Some(2.0), at, "syslog-2", "grok"));
            }
            run(&mut t, at, rs);
        }
        let f = findings("prod", &t, 0, 10 * H, 5 * H, 2 * H, &ClusterFacts::default());
        assert_eq!(f.len(), 1, "{f:?}");
        assert_eq!(f[0].step, Step::Forwarder);
        assert_eq!(f[0].group, Some(("fwd_tag".into(), "syslog-1".into())));
        assert_eq!(f[0].devices.len(), 4);
        assert!(f[0].fix.contains("syslog-1"));
        let each = per_device(&f);
        assert_eq!(each[&("prod".to_string(), "a-2".to_string())].step, Step::Forwarder);
        assert!(!each.contains_key(&("prod".to_string(), "b-0".to_string())), "an on-time device has no finding");
        // The same hostname on another cluster keeps its own finding.
        let mut two = f.clone();
        two.push(Finding { cluster: "other".into(), step: Step::Unknown, ..f[0].clone() });
        let each = per_device(&two);
        assert_eq!(each[&("other".to_string(), "a-2".to_string())].step, Step::Unknown);
        assert_eq!(each[&("prod".to_string(), "a-2".to_string())].step, Step::Forwarder);
    }

    #[test]
    fn many_devices_across_forwarders_is_elasticsearch_with_the_snapshot_named() {
        let mut t = Tracker::default();
        for i in 0..2 {
            let at = i * 2 * H;
            let rs = (0..10).map(|n| reading(&format!("d-{n}"), Some(70.0), at, if n % 2 == 0 { "f1" } else { "f2" }, "")).collect();
            run(&mut t, at, rs);
        }
        let facts = ClusterFacts { write_rejected: Some(1240), nodes_over_watermark: Some(0), snapshots: vec![(H, 3 * H, "nightly".into())], snapshots_known: true };
        let f = findings("prod", &t, 0, 10 * H, 3 * H, 2 * H, &facts);
        assert_eq!(f[0].step, Step::Elasticsearch, "{f:?}");
        assert_eq!(f[0].devices.len(), 10);
        assert!(f[0].fix.contains("nightly"), "{}", f[0].fix);
        assert_eq!(f[0].evidence["writeRejected"], 1240);
        assert!(f[0].missing.is_empty());
        // Without the cache the same pattern still matches, and says what it could not read.
        let g = findings("prod", &t, 0, 10 * H, 3 * H, 2 * H, &ClusterFacts::default());
        assert_eq!(g[0].step, Step::Elasticsearch);
        assert!(g[0].missing.iter().any(|m| m.contains("rejections")), "{:?}", g[0].missing);
    }

    #[test]
    fn a_whole_hour_offset_is_the_clock_and_nothing_matched_says_so() {
        let mut t = Tracker::default();
        for i in 0..4 {
            let at = i * 2 * H;
            run(&mut t, at, vec![reading("tz", Some(60.0), at, "", ""), reading("odd", Some(45.0 + i as f64), at, "", ""), reading("ok", Some(1.0), at, "", "")]);
        }
        let f = findings("prod", &t, 0, 10 * H, 7 * H, 2 * H, &ClusterFacts::default());
        let clock = f.iter().find(|x| x.step == Step::DeviceClock).expect("a clock finding");
        assert_eq!(clock.devices, vec!["tz".to_string()]);
        let unknown = f.iter().find(|x| x.step == Step::Unknown).expect("not enough evidence");
        assert_eq!(unknown.devices, vec!["odd".to_string()]);
        assert!(unknown.missing.iter().any(|m| m.contains("fwd_tag")), "{:?}", unknown.missing);
    }

    #[test]
    fn silence_then_a_late_burst_is_the_device_link() {
        let mut t = Tracker::default();
        run(&mut t, 0, vec![reading("app", Some(1.0), 0, "", ""), reading("ok", Some(1.0), 0, "", "")]);
        run(&mut t, 2 * H, vec![reading("ok", Some(1.0), 2 * H, "", "")]);
        run(&mut t, 4 * H, vec![reading("app", Some(90.0), 4 * H, "", ""), reading("ok", Some(1.0), 4 * H, "", "")]);
        let f = findings("prod", &t, 0, 10 * H, 5 * H, 2 * H, &ClusterFacts::default());
        assert_eq!(f.len(), 1, "{f:?}");
        assert_eq!(f[0].step, Step::DeviceLink);
        assert_eq!(f[0].evidence["burstMinutes"], 90.0);
    }

    #[test]
    fn one_group_with_nobody_to_compare_against_claims_nothing_and_a_parser_without_fwd_tag_says_so() {
        // Every device on one forwarder, all late: no "others were on time" to read.
        let mut t = Tracker::default();
        for i in 0..2 {
            let at = i * 2 * H;
            run(&mut t, at, (0..3).map(|n| reading(&format!("a-{n}"), Some(50.0), at, "syslog-1", "")).collect());
        }
        let f = findings("prod", &t, 0, 10 * H, 3 * H, 2 * H, &ClusterFacts::default());
        assert!(f.iter().all(|x| x.step != Step::Forwarder), "{f:?}");
        assert_eq!(f.iter().find(|x| x.step == Step::Unknown).map(|x| x.devices.len()), Some(3));
        // One parser late, another on time, no fwd_tag anywhere: a parser finding, with the gap named.
        let mut t = Tracker::default();
        for i in 0..2 {
            let at = i * 2 * H;
            let mut rs: Vec<Reading> = (0..3).map(|n| reading(&format!("p-{n}"), Some(50.0), at, "", "fortigate-grok")).collect();
            rs.extend((0..4).map(|n| reading(&format!("q-{n}"), Some(1.0), at, "", "cisco")));
            run(&mut t, at, rs);
        }
        let f = findings("prod", &t, 0, 10 * H, 3 * H, 2 * H, &ClusterFacts::default());
        let p = f.iter().find(|x| x.step == Step::Parser).expect("a parser finding");
        assert!(p.missing.iter().any(|m| m.contains("fwd_tag")), "{:?}", p.missing);
    }

    #[test]
    fn facts_are_read_from_the_cache_and_unknown_stays_unknown() {
        let shards = json!({ "threadPools": { "json": [
            { "node_name": "n1", "name": "write", "rejected": "1200" }, { "node_name": "n2", "name": "write", "rejected": 40 }, { "name": "search", "rejected": "9" } ] } });
        let policies = json!({ "slm": { "json": { "nightly": { "last_success": { "start_time_millis": 1000, "time": 5000 } } } },
                               "clusterSettings": { "json": { "defaults": { "cluster.routing.allocation.disk.watermark.high": "90%" } } } });
        let nodes = json!({ "alloc": { "json": [ { "node": "a", "disk.percent": "95" }, { "node": "b", "disk.percent": "40" } ] } });
        let f = facts_from_cache(Some(&shards), Some(&policies), Some(&nodes), 0, 10_000);
        assert_eq!(f.write_rejected, Some(1240));
        assert_eq!(f.nodes_over_watermark, Some(1));
        assert_eq!(f.snapshots, vec![(1000, 5000, "nightly".to_string())]);
        let none = facts_from_cache(None, None, None, 0, 10);
        assert_eq!((none.write_rejected, none.nodes_over_watermark, none.snapshots_known), (None, None, false));
    }
}
