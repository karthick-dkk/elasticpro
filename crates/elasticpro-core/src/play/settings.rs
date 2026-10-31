//! Play settings (docs/PLAY.md "Play settings"): `<data>/play.json`.
//!
//! What every wall watches for (`watch`), the clusters left off every wall (`exclude`, each
//! with a reason), and how each display shows it (`displays` by link id, `defaultDisplay` for
//! a person who presses ▶ Play). `UI_PLAY_*` keys in config.txt lock their `watch` field, last,
//! over whatever the file says; `UI_PLAY_EXCLUDE` adds exclusions of its own (reason "set in
//! config.txt", `managed: true`) that the page cannot remove. The page shows such a field as
//! "managed by config.txt".

use crate::settings::Settings;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const FILE: &str = "play.json";

/// What can put a cluster in the spotlight. The first six are on by default.
pub const SPOTLIGHT_WHEN: &[&str] = &["red", "nodeLeft", "slmFailed", "storage", "unreachable", "criticalAlert", "ilmError", "yellow"];
const SPOTLIGHT_DEFAULT: &[&str] = &["red", "nodeLeft", "slmFailed", "storage", "unreachable", "criticalAlert"];
/// The slides, in their default order.
pub const SLIDES: &[&str] = &["fleet", "alerts", "spotlight", "delay", "backups", "volume"];
/// The zoom steps the top bar offers.
pub const ZOOMS: &[f64] = &[0.8, 0.9, 1.0, 1.1, 1.25, 1.5];
pub const NODE_EXPECTED: &[&str] = &["seen24h", "pinned"];
pub const NODE_BLINK: &[&str] = &["untilBack", "untilAck", "off"];
pub const WHEN_EMPTY: &[&str] = &["skip", "allHealthy", "everyCluster"];
pub const THEMES: &[&str] = &["dark", "light"];
pub const SOUNDS: &[&str] = &["off", "chime"];

/// The config.txt keys of Play, in config.txt.example's order.
pub const KEYS: &[&str] = &[
    "UI_PLAY_ENABLED", "UI_PLAY_DELAY_YELLOW_MIN", "UI_PLAY_DELAY_RED_MIN", "UI_PLAY_NODE_EXPECTED",
    "UI_PLAY_NODE_BLINK", "UI_PLAY_NODE_CHECK_SECONDS", "UI_PLAY_SPOTLIGHT_WHEN", "UI_PLAY_SPOTLIGHT_LEAVE_MIN",
    "UI_PLAY_SPOTLIGHT_SECONDS", "UI_PLAY_EXCLUDE",
];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Spotlight {
    pub when: Vec<String>,
    pub per_cluster_sec: u32,
    pub leave_after_min: u32,
    pub when_empty: String,
}

impl Default for Spotlight {
    fn default() -> Self {
        Spotlight {
            when: SPOTLIGHT_DEFAULT.iter().map(|s| s.to_string()).collect(),
            per_cluster_sec: 13,
            leave_after_min: 10,
            when_empty: "skip".into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Watch {
    pub delay_yellow_from_min: u32,
    pub delay_red_above_min: u32,
    pub node_expected: String,
    pub node_blink: String,
    pub node_check_sec: u32,
    pub spotlight: Spotlight,
    /// With `nodeExpected: "pinned"`: the node names each cluster is expected to have. A
    /// cluster with no list here falls back to the names seen in the last 24 h.
    pub pinned: BTreeMap<String, Vec<String>>,
}

impl Default for Watch {
    fn default() -> Self {
        Watch {
            delay_yellow_from_min: 30,
            delay_red_above_min: 60,
            node_expected: "seen24h".into(),
            node_blink: "untilBack".into(),
            node_check_sec: 60,
            spotlight: Spotlight::default(),
            pinned: BTreeMap::new(),
        }
    }
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exclude {
    pub cluster_id: String,
    pub reason: String,
    #[serde(default)]
    pub by: String,
    /// ms since the epoch.
    #[serde(default)]
    pub at: u64,
    /// From config.txt (`UI_PLAY_EXCLUDE`): the page cannot remove it. Never stored.
    #[serde(default, skip_serializing_if = "is_false")]
    pub managed: bool,
}

/// One slide of a display, in the display's order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Slide {
    pub id: String,
    #[serde(default = "yes")]
    pub show: bool,
    #[serde(default = "twenty")]
    pub dwell_sec: u32,
}

fn yes() -> bool {
    true
}

fn twenty() -> u32 {
    20
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Display {
    pub slides: Vec<Slide>,
    pub critical_takes_screen: bool,
    /// The spotlight shows every cluster in turn, not only those with a critical problem.
    pub spotlight_all: bool,
    pub theme: String,
    pub sound: String,
    /// Fixed by the administrator; `None`: the TV keeps what was last set on it (`PLAY_ZOOM_SET`).
    pub zoom: Option<f64>,
}

impl Default for Display {
    fn default() -> Self {
        Display {
            slides: SLIDES.iter().map(|s| Slide { id: s.to_string(), show: true, dwell_sec: 20 }).collect(),
            critical_takes_screen: true,
            spotlight_all: false,
            theme: "dark".into(),
            sound: "off".into(),
            zoom: None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlaySettings {
    pub watch: Watch,
    pub exclude: Vec<Exclude>,
    pub displays: BTreeMap<String, Display>,
    pub default_display: Display,
    /// The zoom each display link's TV last set on itself (`PLAY_ZOOM_SET`), by link id.
    pub tv_zoom: BTreeMap<String, f64>,
}

fn one_of(field: &str, v: &str, options: &[&str]) -> Result<(), String> {
    if options.contains(&v) {
        Ok(())
    } else {
        Err(format!("{field}: {v:?} is not one of {}", options.join(", ")))
    }
}

fn range(field: &str, v: u32, lo: u32, hi: u32) -> Result<(), String> {
    if (lo..=hi).contains(&v) {
        Ok(())
    } else {
        Err(format!("{field}: {v} is not a whole number from {lo} to {hi}"))
    }
}

/// A zoom step, or the refusal.
pub fn check_zoom(field: &str, z: f64) -> Result<(), String> {
    if ZOOMS.iter().any(|s| (s - z).abs() < 1e-9) {
        Ok(())
    } else {
        Err(format!("{field}: {z} is not one of 0.8, 0.9, 1, 1.1, 1.25, 1.5"))
    }
}

impl Display {
    pub fn validate(&self, at: &str) -> Result<(), String> {
        if !self.slides.iter().any(|s| s.show) {
            return Err(format!("{at}.slides: show at least one slide"));
        }
        for (i, s) in self.slides.iter().enumerate() {
            one_of(&format!("{at}.slides"), &s.id, SLIDES)?;
            if self.slides[..i].iter().any(|o| o.id == s.id) {
                return Err(format!("{at}.slides: {:?} is listed twice", s.id));
            }
            range(&format!("{at}.slides.{}.dwellSec", s.id), s.dwell_sec, 5, 600)?;
        }
        one_of(&format!("{at}.theme"), &self.theme, THEMES)?;
        one_of(&format!("{at}.sound"), &self.sound, SOUNDS)?;
        if let Some(z) = self.zoom {
            check_zoom(&format!("{at}.zoom"), z)?;
        }
        Ok(())
    }
}

impl PlaySettings {
    /// Every rule a saved file and a page's change must both pass.
    pub fn validate(&self) -> Result<(), String> {
        let w = &self.watch;
        range("watch.delayYellowFromMin", w.delay_yellow_from_min, 1, 1440)?;
        range("watch.delayRedAboveMin", w.delay_red_above_min, 1, 1440)?;
        if w.delay_red_above_min < w.delay_yellow_from_min {
            return Err("watch.delayRedAboveMin must not be below watch.delayYellowFromMin".into());
        }
        one_of("watch.nodeExpected", &w.node_expected, NODE_EXPECTED)?;
        one_of("watch.nodeBlink", &w.node_blink, NODE_BLINK)?;
        range("watch.nodeCheckSec", w.node_check_sec, 10, 3600)?;
        for s in &w.spotlight.when {
            one_of("watch.spotlight.when", s, SPOTLIGHT_WHEN)?;
        }
        range("watch.spotlight.perClusterSec", w.spotlight.per_cluster_sec, 5, 120)?;
        range("watch.spotlight.leaveAfterMin", w.spotlight.leave_after_min, 1, 1440)?;
        one_of("watch.spotlight.whenEmpty", &w.spotlight.when_empty, WHEN_EMPTY)?;
        if w.pinned.len() > 1000 || w.pinned.values().any(|v| v.len() > 1000 || v.iter().any(|n| n.trim().is_empty() || n.len() > 256)) {
            return Err("watch.pinned: per cluster, a list of node names".into());
        }
        if self.exclude.len() > 1000 {
            return Err("exclude: at most 1000 clusters".into());
        }
        for e in &self.exclude {
            if e.cluster_id.trim().is_empty() || e.cluster_id.len() > 256 {
                return Err("exclude: every entry names a clusterId".into());
            }
            if e.reason.trim().is_empty() {
                return Err(format!("exclude: {:?} needs a reason — say why it is left off the wall", e.cluster_id));
            }
            if e.reason.len() > 300 {
                return Err(format!("exclude: the reason for {:?} is longer than 300 characters", e.cluster_id));
            }
        }
        self.default_display.validate("defaultDisplay")?;
        for (id, d) in &self.displays {
            d.validate(&format!("displays.{id}"))?;
        }
        for z in self.tv_zoom.values() {
            check_zoom("tvZoom", *z)?;
        }
        Ok(())
    }

    /// Read the file: anything unreadable or invalid is the defaults (and said so in the log).
    pub fn load(path: Option<&std::path::Path>) -> PlaySettings {
        let Some(p) = path else { return PlaySettings::default() };
        let Ok(text) = std::fs::read_to_string(p) else { return PlaySettings::default() };
        match serde_json::from_str::<PlaySettings>(&text).map_err(|e| e.to_string()).and_then(|s| s.validate().map(|_| s)) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(file = %p.display(), error = %e, "Play settings could not be read; the defaults apply");
                PlaySettings::default()
            }
        }
    }

    /// This display's settings: its own when it has some, else the default display's.
    pub fn display_for(&self, link: Option<&str>) -> Display {
        link.and_then(|l| self.displays.get(l)).cloned().unwrap_or_else(|| self.default_display.clone())
    }

    /// The zoom a display shows: the administrator's when fixed, else what its TV last set,
    /// else 1.
    pub fn zoom_for(&self, link: Option<&str>) -> f64 {
        self.display_for(link).zoom
            .or_else(|| link.and_then(|l| self.tv_zoom.get(l)).copied())
            .unwrap_or(1.0)
    }

    /// Ids of the excluded clusters.
    pub fn excluded(&self) -> Vec<String> {
        self.exclude.iter().map(|e| e.cluster_id.clone()).collect()
    }
}

/* ------------------------------- config.txt locks ------------------------------- */

/// config.txt key -> the `watch` field it locks, as a JSON pointer into the settings.
pub const MANAGED: &[(&str, &str)] = &[
    ("UI_PLAY_DELAY_YELLOW_MIN", "/watch/delayYellowFromMin"),
    ("UI_PLAY_DELAY_RED_MIN", "/watch/delayRedAboveMin"),
    ("UI_PLAY_NODE_EXPECTED", "/watch/nodeExpected"),
    ("UI_PLAY_NODE_BLINK", "/watch/nodeBlink"),
    ("UI_PLAY_NODE_CHECK_SECONDS", "/watch/nodeCheckSec"),
    ("UI_PLAY_SPOTLIGHT_WHEN", "/watch/spotlight/when"),
    ("UI_PLAY_SPOTLIGHT_LEAVE_MIN", "/watch/spotlight/leaveAfterMin"),
    ("UI_PLAY_SPOTLIGHT_SECONDS", "/watch/spotlight/perClusterSec"),
];

/// The reason an exclusion from config.txt carries.
pub const CONFIG_REASON: &str = "set in config.txt";

/// A comma list, trimmed, empties dropped.
pub fn comma_list(v: &str) -> Vec<String> {
    v.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

/// `UI_PLAY_SPOTLIGHT_WHEN`: a comma list of `SPOTLIGHT_WHEN` names (any case), or `none`.
pub fn spotlight_when_problem(v: &str) -> Option<String> {
    if v.trim().eq_ignore_ascii_case("none") {
        return None;
    }
    let list = comma_list(v);
    if list.is_empty() {
        return Some("names nothing (use none for an empty list)".into());
    }
    list.iter().find(|x| !SPOTLIGHT_WHEN.iter().any(|o| o.eq_ignore_ascii_case(x)))
        .map(|bad| format!("{bad:?} is not one of {}", SPOTLIGHT_WHEN.join(", ")))
}

fn spotlight_when(v: &str) -> Vec<String> {
    if v.trim().eq_ignore_ascii_case("none") {
        return vec![];
    }
    comma_list(v).iter().filter_map(|x| SPOTLIGHT_WHEN.iter().find(|o| o.eq_ignore_ascii_case(x)).map(|o| o.to_string())).collect()
}

/// The config.txt exclusions.
fn managed_excludes(managed: &Settings) -> Vec<Exclude> {
    comma_list(managed.text("UI_PLAY_EXCLUDE").unwrap_or_default()).into_iter()
        .map(|id| Exclude { cluster_id: id, reason: CONFIG_REASON.into(), by: "config.txt".into(), at: 0, managed: true })
        .collect()
}

/// The settings with config.txt applied over them, and the pointers of the fields it locks.
pub fn resolve(stored: &PlaySettings, managed: &Settings) -> (PlaySettings, Vec<&'static str>) {
    let mut s = stored.clone();
    let mut locked = vec![];
    let int = |k: &str| managed.text(k).and_then(|v| v.parse::<u32>().ok());
    for (key, ptr) in MANAGED {
        if !managed.manages(key) {
            continue;
        }
        let w = &mut s.watch;
        match *key {
            "UI_PLAY_DELAY_YELLOW_MIN" => if let Some(n) = int(key) { w.delay_yellow_from_min = n },
            "UI_PLAY_DELAY_RED_MIN" => if let Some(n) = int(key) { w.delay_red_above_min = n },
            "UI_PLAY_NODE_EXPECTED" => w.node_expected = managed.text(key).unwrap_or_default().to_string(),
            "UI_PLAY_NODE_BLINK" => w.node_blink = managed.text(key).unwrap_or_default().to_string(),
            "UI_PLAY_NODE_CHECK_SECONDS" => if let Some(n) = int(key) { w.node_check_sec = n },
            "UI_PLAY_SPOTLIGHT_WHEN" => w.spotlight.when = spotlight_when(managed.text(key).unwrap_or_default()),
            "UI_PLAY_SPOTLIGHT_LEAVE_MIN" => if let Some(n) = int(key) { w.spotlight.leave_after_min = n },
            "UI_PLAY_SPOTLIGHT_SECONDS" => if let Some(n) = int(key) { w.spotlight.per_cluster_sec = n },
            _ => continue,
        }
        locked.push(*ptr);
    }
    // Two managed thresholds that contradict each other: red follows yellow, rather than a
    // wall that colours nothing red.
    if s.watch.delay_red_above_min < s.watch.delay_yellow_from_min {
        s.watch.delay_red_above_min = s.watch.delay_yellow_from_min;
    }
    // config.txt's exclusions first, then the page's for every other cluster.
    let from_txt = managed_excludes(managed);
    s.exclude.retain(|e| !from_txt.iter().any(|m| m.cluster_id == e.cluster_id));
    s.exclude.splice(0..0, from_txt);
    (s, locked)
}

/// Whether display links are on: `UI_PLAY_ENABLED`, default true.
pub fn links_enabled(managed: &Settings) -> bool {
    managed.flag("UI_PLAY_ENABLED").unwrap_or(true)
}

/// The `UI_PLAY_*` keys config.txt manages, by name (the page's `managed`).
pub fn managed_keys(managed: &Settings) -> Vec<&'static str> {
    KEYS.iter().copied().filter(|k| managed.manages(k)).collect()
}

/// `{"watch.delayYellowFromMin": "UI_PLAY_DELAY_YELLOW_MIN", …}`: each locked field and its key.
pub fn managed_fields(locked: &[&str]) -> Value {
    let mut m = serde_json::Map::new();
    for p in locked {
        let key = MANAGED.iter().find(|(_, q)| q == p).map(|(k, _)| *k).unwrap_or("");
        m.insert(p.trim_start_matches('/').replace('/', "."), json!(key));
    }
    Value::Object(m)
}

/// Merge `patch` into `base`: objects field by field, anything else replaced.
pub fn merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(b), Value::Object(p)) => {
            for (k, v) in p {
                match b.get_mut(k) {
                    Some(slot) if slot.is_object() && v.is_object() => merge(slot, v),
                    _ => {
                        b.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (b, p) => *b = p.clone(),
    }
}

/// A page's change, applied to `current` (the stored settings, without config.txt).
///
/// * `{watch: {...}}`: merged field by field. A locked field the change names with the value
///   config.txt gives is accepted (a page that sends the whole object back is not refused for
///   it); with another value it is refused; left out, the stored value stays.
/// * `{exclude: {add: {clusterId, reason}}}` / `{exclude: {remove: clusterId}}`: one cluster
///   at a time; the server fills `by` and `at`. A config.txt exclusion cannot be removed.
/// * `{exclude: [...]}`: the whole list (a script's form); entries that did not change keep
///   their `by` and `at`.
/// * `{defaultDisplay: {...}}`, `{displays: {<linkId>: {...}}}`: merged.
pub fn apply_change(current: &PlaySettings, patch: &Value, managed: &Settings, by: &str, now_ms: u64)
    -> Result<PlaySettings, String> {
    let Some(pm) = patch.as_object() else { return Err("settings must be an object".into()) };
    if let Some(k) = pm.keys().find(|k| !matches!(k.as_str(), "watch" | "exclude" | "defaultDisplay" | "displays")) {
        return Err(format!("settings: {k:?} is not something Play keeps (watch, exclude, defaultDisplay, displays)"));
    }
    let (effective, locked) = resolve(current, managed);
    let effective_v = serde_json::to_value(&effective).map_err(|e| e.to_string())?;
    for ptr in &locked {
        if let Some(asked) = patch.pointer(ptr) {
            if Some(asked) != effective_v.pointer(ptr) {
                return Err(format!("{} is managed by config.txt ({}) and cannot be changed here",
                    ptr.trim_start_matches('/').replace('/', "."),
                    MANAGED.iter().find(|(_, p)| p == ptr).map(|(k, _)| *k).unwrap_or("")));
            }
        }
    }
    let from_txt = managed_excludes(managed);
    let is_txt = |id: &str| from_txt.iter().any(|m| m.cluster_id == id);
    let mut v = serde_json::to_value(current).map_err(|e| e.to_string())?;
    let mut patch = patch.clone();
    let mut exclude = current.exclude.clone();
    if let Some(ex) = patch.as_object_mut().and_then(|m| m.remove("exclude")) {
        match &ex {
            Value::Object(op) => {
                if let Some(add) = op.get("add") {
                    let id = add.get("clusterId").and_then(Value::as_str).map(str::trim).unwrap_or("");
                    let reason = add.get("reason").and_then(Value::as_str).map(str::trim).unwrap_or("");
                    if id.is_empty() {
                        return Err("exclude.add: name the cluster (clusterId)".into());
                    }
                    if reason.is_empty() {
                        return Err(format!("exclude: {id:?} needs a reason — say why it is left off the wall"));
                    }
                    if is_txt(id) {
                        return Err(format!("exclude: {id:?} is excluded by config.txt (UI_PLAY_EXCLUDE) already"));
                    }
                    exclude.retain(|e| e.cluster_id != id);
                    exclude.push(Exclude { cluster_id: id.into(), reason: reason.into(), by: by.into(), at: now_ms, managed: false });
                } else if let Some(id) = op.get("remove").and_then(Value::as_str).map(str::trim) {
                    if is_txt(id) {
                        return Err(format!("exclude: {id:?} is managed by config.txt (UI_PLAY_EXCLUDE) and cannot be removed here"));
                    }
                    exclude.retain(|e| e.cluster_id != id);
                } else {
                    return Err("exclude: {add: {clusterId, reason}} or {remove: clusterId}".into());
                }
            }
            Value::Array(_) => {
                let list: Vec<Exclude> = serde_json::from_value(ex.clone()).map_err(|e| format!("exclude: {e}"))?;
                exclude = vec![];
                for mut e in list.into_iter().filter(|e| !e.managed && !is_txt(e.cluster_id.trim())) {
                    e.cluster_id = e.cluster_id.trim().to_string();
                    e.reason = e.reason.trim().to_string();
                    match current.exclude.iter().find(|o| o.cluster_id == e.cluster_id && o.reason == e.reason) {
                        Some(o) => {
                            e.by = o.by.clone();
                            e.at = o.at;
                        }
                        None => {
                            e.by = by.to_string();
                            e.at = now_ms;
                        }
                    }
                    if !exclude.iter().any(|x: &Exclude| x.cluster_id == e.cluster_id) {
                        exclude.push(e);
                    }
                }
            }
            _ => return Err("exclude: {add: {clusterId, reason}}, {remove: clusterId}, or the whole list".into()),
        }
    }
    merge(&mut v, &patch);
    let mut next: PlaySettings = serde_json::from_value(v).map_err(|e| format!("settings: {e}"))?;
    next.exclude = exclude;
    next.validate()?;
    // What the page saves must also hold once config.txt is applied over it.
    resolve(&next, managed).0.validate()?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_contracts() {
        let s = PlaySettings::default();
        assert!(s.validate().is_ok());
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["watch"]["delayYellowFromMin"], json!(30));
        assert_eq!(v["watch"]["delayRedAboveMin"], json!(60));
        assert_eq!(v["watch"]["nodeExpected"], json!("seen24h"));
        assert_eq!(v["watch"]["nodeBlink"], json!("untilBack"));
        assert_eq!(v["watch"]["nodeCheckSec"], json!(60));
        assert_eq!(v["watch"]["spotlight"]["when"], json!(["red", "nodeLeft", "slmFailed", "storage", "unreachable", "criticalAlert"]));
        assert_eq!(v["watch"]["spotlight"]["perClusterSec"], json!(13));
        assert_eq!(v["watch"]["spotlight"]["leaveAfterMin"], json!(10));
        assert_eq!(v["defaultDisplay"]["slides"][0], json!({ "id": "fleet", "show": true, "dwellSec": 20 }));
        assert_eq!(v["defaultDisplay"]["criticalTakesScreen"], json!(true));
        assert_eq!(v["defaultDisplay"]["zoom"], Value::Null);
        assert_eq!(s.zoom_for(Some("x")), 1.0);
    }

    #[test]
    fn exclude_needs_a_reason_and_is_stamped() {
        let cur = PlaySettings::default();
        let none = Settings::default();
        let e = apply_change(&cur, &json!({ "exclude": { "add": { "clusterId": "c1", "reason": "  " } } }), &none, "kd", 5).unwrap_err();
        assert!(e.contains("needs a reason"), "{e}");
        let e = apply_change(&cur, &json!({ "exclude": [{ "clusterId": "c1", "reason": "" }] }), &none, "kd", 5).unwrap_err();
        assert!(e.contains("needs a reason"), "{e}");
        let s = apply_change(&cur, &json!({ "exclude": { "add": { "clusterId": "c1", "reason": "migrating" } } }), &none, "kd", 5).unwrap();
        assert_eq!((s.exclude[0].by.as_str(), s.exclude[0].at), ("kd", 5), "stamped by the server");
        let again = apply_change(&s, &json!({ "watch": { "nodeCheckSec": 30 } }), &none, "other", 9).unwrap();
        assert_eq!((again.exclude[0].by.as_str(), again.exclude[0].at), ("kd", 5), "a watch change leaves the exclusions");
        assert_eq!(again.watch.node_check_sec, 30);
        assert_eq!(again.watch.delay_yellow_from_min, 30, "a partial change leaves the rest");
        let gone = apply_change(&again, &json!({ "exclude": { "remove": "c1" } }), &none, "other", 9).unwrap();
        assert!(gone.exclude.is_empty());
    }

    #[test]
    fn ranges_and_names_are_checked() {
        let cur = PlaySettings::default();
        let none = Settings::default();
        for bad in [
            json!({ "watch": { "delayYellowFromMin": 0 } }),
            json!({ "watch": { "delayYellowFromMin": 90 } }),
            json!({ "watch": { "nodeBlink": "always" } }),
            json!({ "watch": { "spotlight": { "when": ["red", "purple"] } } }),
            json!({ "defaultDisplay": { "zoom": 3 } }),
            json!({ "defaultDisplay": { "sound": "loud" } }),
            json!({ "defaultDisplay": { "slides": [{ "id": "fleet" }, { "id": "fleet" }] } }),
            json!({ "defaultDisplay": { "slides": [{ "id": "fleet", "show": false }] } }),
            json!({ "watch": { "surprise": 1 } }),
            json!({ "links": [] }),
        ] {
            assert!(apply_change(&cur, &bad, &none, "kd", 1).is_err(), "{bad}");
        }
    }

    #[test]
    fn config_txt_locks_its_fields_and_adds_its_exclusions() {
        let txt = Settings::parse("UI_PLAY_DELAY_YELLOW_MIN=20\nUI_PLAY_NODE_BLINK=off\nUI_PLAY_SPOTLIGHT_WHEN=red, yellow\nUI_PLAY_EXCLUDE=c9, c8\n");
        assert!(txt.warnings().is_empty(), "{:?}", txt.warnings());
        let mut stored = PlaySettings::default();
        stored.exclude.push(Exclude { cluster_id: "c1".into(), reason: "lab".into(), by: "kd".into(), at: 3, managed: false });
        let (s, locked) = resolve(&stored, &txt);
        assert_eq!(s.watch.delay_yellow_from_min, 20);
        assert_eq!(s.watch.node_blink, "off");
        assert_eq!(s.watch.spotlight.when, vec!["red", "yellow"]);
        assert_eq!(s.excluded(), vec!["c9", "c8", "c1"], "config.txt's, then the page's");
        assert!(s.exclude[0].managed && s.exclude[0].reason == CONFIG_REASON && !s.exclude[2].managed);
        assert_eq!(managed_keys(&txt), vec!["UI_PLAY_DELAY_YELLOW_MIN", "UI_PLAY_NODE_BLINK", "UI_PLAY_SPOTLIGHT_WHEN", "UI_PLAY_EXCLUDE"]);
        assert_eq!(managed_fields(&locked)["watch.nodeBlink"], json!("UI_PLAY_NODE_BLINK"));
        // A locked field with another value is refused; with config.txt's own value it passes.
        let e = apply_change(&stored, &json!({ "watch": { "delayYellowFromMin": 45 } }), &txt, "kd", 1).unwrap_err();
        assert!(e.contains("managed by config.txt"), "{e}");
        assert!(apply_change(&stored, &json!({ "watch": { "delayYellowFromMin": 20, "nodeCheckSec": 30 } }), &txt, "kd", 1).is_ok());
        // A config.txt exclusion cannot be removed or added again; another cluster can.
        assert!(apply_change(&stored, &json!({ "exclude": { "remove": "c9" } }), &txt, "kd", 1).unwrap_err().contains("managed by config.txt"));
        assert!(apply_change(&stored, &json!({ "exclude": { "add": { "clusterId": "c8", "reason": "x" } } }), &txt, "kd", 1).is_err());
        let ok = apply_change(&stored, &json!({ "exclude": { "add": { "clusterId": "c2", "reason": "x" } } }), &txt, "kd", 1).unwrap();
        assert_eq!(ok.excluded(), vec!["c1", "c2"], "config.txt's are never stored");
        assert!(links_enabled(&Settings::default()));
        assert!(!links_enabled(&Settings::parse("UI_PLAY_ENABLED=false\n")));
    }

    #[test]
    fn spotlight_when_from_config_txt() {
        assert_eq!(spotlight_when_problem("Red, NODELEFT"), None);
        assert_eq!(spotlight_when_problem("none"), None);
        assert!(spotlight_when_problem("red, purple").is_some());
        assert!(spotlight_when_problem(" , ").is_some());
        assert_eq!(spotlight_when("Red, NODELEFT"), vec!["red", "nodeLeft"]);
    }
}
