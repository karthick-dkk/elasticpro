//! What the volume record counts and how: `defaults.volume` in the clusters file.
//!
//! Four layers, later wins, each one any subset of the keys:
//!
//! ```text
//!   built-in  <  defaults.volume  <  cluster override  <  config.txt (UI_VOLUME_*)
//! ```
//!
//! A cluster override is `defaults.volume.overrides[<id>]` or `clusters[].volume` — the
//! contract counts both as one; `clusters[].volume` goes first and the overrides map on
//! top, because the map is what the editor writes. config.txt locks its rows everywhere,
//! which is why `managed` lists them by the names PING's `managedDefaults` uses.
//!
//! The legacy `volumeFields` list (one flat list of field names, defaults or cluster) is
//! read only where there is no `volume` at that level, and turned into the rows it meant:
//! `tag1` the tag, `fwd_tag`/`fwdtag` the forwarder, `src_hostname` the source host,
//! `src_ip` the source IP, anything else the extra row.
//!
//! A value that does not fit (a basis that is not one of the three, a `topValues` of
//! 1000) is ignored and the layer below stands: a typo in one key should not take the
//! rest of a cluster's settings with it.

use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SizeBasis {
    /// Primary store size from `_cat/indices`: what the data costs once.
    #[default]
    Primary,
    /// With replicas: what it costs on disk.
    Total,
    /// The shipper's own byte count (`event_logsize`): what was sent.
    EventSize,
}

impl SizeBasis {
    pub fn parse(s: &str) -> Option<SizeBasis> {
        match s.trim().to_ascii_lowercase().as_str() {
            "primary" => Some(SizeBasis::Primary),
            "total" => Some(SizeBasis::Total),
            "eventsize" => Some(SizeBasis::EventSize),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Extra {
    pub name: String,
    pub fields: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeSettings {
    pub index_format: String,
    pub tag: Vec<String>,
    pub forwarder: Vec<String>,
    pub source_host: Vec<String>,
    pub source_ip: Vec<String>,
    pub event_size: Vec<String>,
    pub sub_size: Vec<String>,
    pub extra: Extra,
    pub size_basis: SizeBasis,
    pub top_values: u32,
    pub keep_months: u32,
    pub collect_at: String,
}

fn list(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| s.to_string()).collect()
}

impl Default for VolumeSettings {
    fn default() -> VolumeSettings {
        VolumeSettings {
            index_format: "logstash-*-YYYY.MM.DD".into(),
            tag: list(&["tag1", "labels.tag1", "tags"]),
            forwarder: list(&["fwd_tag", "fwdtag", "observer.name"]),
            source_host: list(&["src_hostname", "host.name"]),
            source_ip: list(&["src_ip", "source.ip", "host.ip"]),
            event_size: list(&["event_logsize"]),
            sub_size: list(&["sub_size"]),
            extra: Extra { name: "Dataset".into(), fields: list(&["event.dataset", "log_type"]) },
            size_basis: SizeBasis::Primary,
            top_values: 25,
            keep_months: 13,
            collect_at: "06:00".into(),
        }
    }
}

/// config.txt key → the settings key it manages → the name PING carries it under.
pub const MANAGED: &[(&str, &str, &str)] = &[
    ("UI_VOLUME_INDEX_FORMAT", "indexFormat", "volumeIndexFormat"),
    ("UI_VOLUME_TAG_FIELDS", "tag", "volumeTag"),
    ("UI_VOLUME_FORWARDER_FIELDS", "forwarder", "volumeForwarder"),
    ("UI_VOLUME_HOST_FIELDS", "sourceHost", "volumeSourceHost"),
    ("UI_VOLUME_IP_FIELDS", "sourceIp", "volumeSourceIp"),
    ("UI_VOLUME_EVENT_SIZE_FIELD", "eventSize", "volumeEventSize"),
    ("UI_VOLUME_SUB_SIZE_FIELD", "subSize", "volumeSubSize"),
    ("UI_VOLUME_EXTRA_NAME", "extra.name", "volumeExtraName"),
    ("UI_VOLUME_EXTRA_FIELDS", "extra.fields", "volumeExtraFields"),
    ("UI_VOLUME_SIZE_BASIS", "sizeBasis", "volumeSizeBasis"),
    ("UI_VOLUME_TOP_VALUES", "topValues", "volumeTopValues"),
    ("UI_VOLUME_KEEP_MONTHS", "keepMonths", "volumeKeepMonths"),
    ("UI_VOLUME_COLLECT_AT", "collectAt", "volumeCollectAt"),
];

/// A field list: an array of names, or one comma-separated string. Blank names dropped;
/// an empty result is "not set" and leaves the layer below standing.
fn names(v: &Value) -> Option<Vec<String>> {
    let out: Vec<String> = match v {
        Value::Array(a) => a.iter().filter_map(|x| x.as_str()).map(|s| s.trim().to_string()).collect(),
        Value::String(s) => s.split(',').map(|s| s.trim().to_string()).collect(),
        _ => return None,
    };
    let out: Vec<String> = out.into_iter().filter(|s| !s.is_empty() && !s.chars().any(char::is_control)).collect();
    (!out.is_empty()).then_some(out)
}

/// Why an `indexFormat` cannot be used, if it cannot.
pub fn index_format_problem(f: &str) -> Option<&'static str> {
    if !f.contains('*') {
        return Some("must contain * (the source part)");
    }
    if f.matches("YYYY.MM.DD").count() != 1 {
        return Some("must contain YYYY.MM.DD once (the day)");
    }
    if f.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, ',' | '/' | '\\' | '?' | '#' | '"' | '<' | '>' | '|')) {
        return Some("must be one index pattern: no spaces, commas or slashes");
    }
    None
}

impl VolumeSettings {
    /// Lay one layer over this one. Unknown keys and values that do not fit are ignored.
    pub fn apply(&mut self, layer: &Value) {
        let Some(m) = layer.as_object() else { return };
        if let Some(f) = m.get("indexFormat").and_then(Value::as_str).map(str::trim) {
            if index_format_problem(f).is_none() {
                self.index_format = f.to_string();
            }
        }
        for (key, slot) in [
            ("tag", &mut self.tag),
            ("forwarder", &mut self.forwarder),
            ("sourceHost", &mut self.source_host),
            ("sourceIp", &mut self.source_ip),
            ("eventSize", &mut self.event_size),
            ("subSize", &mut self.sub_size),
        ] {
            if let Some(v) = m.get(key).and_then(names) {
                *slot = v;
            }
        }
        if let Some(e) = m.get("extra") {
            if let Some(n) = e.get("name").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty() && s.len() <= 60) {
                self.extra.name = n.to_string();
            }
            if let Some(v) = e.get("fields").and_then(names) {
                self.extra.fields = v;
            }
        }
        if let Some(b) = m.get("sizeBasis").and_then(Value::as_str).and_then(SizeBasis::parse) {
            self.size_basis = b;
        }
        if let Some(n) = int(m.get("topValues")).filter(|n| (5..=100).contains(n)) {
            self.top_values = n as u32;
        }
        if let Some(n) = int(m.get("keepMonths")).filter(|n| (1..=36).contains(n)) {
            self.keep_months = n as u32;
        }
        if let Some(t) = m.get("collectAt").and_then(Value::as_str).map(str::trim) {
            if super::schedule::parse_hhmm(t).is_some() {
                self.collect_at = t.to_string();
            }
        }
    }

    /// config.txt, last. Returns the managed names (PING's) of the keys it set.
    pub fn apply_managed(&mut self, s: &crate::settings::Settings) -> Vec<&'static str> {
        let mut layer = serde_json::Map::new();
        let mut extra = serde_json::Map::new();
        let mut managed = vec![];
        for (key, field, name) in MANAGED {
            let Some(v) = s.text(key) else { continue };
            managed.push(*name);
            match field.strip_prefix("extra.") {
                Some(sub) => {
                    extra.insert(sub.into(), json!(v));
                }
                None if matches!(*field, "topValues" | "keepMonths") => {
                    layer.insert((*field).into(), json!(v.parse::<u64>().unwrap_or(0)));
                }
                None => {
                    layer.insert((*field).into(), json!(v));
                }
            }
        }
        if !extra.is_empty() {
            layer.insert("extra".into(), Value::Object(extra));
        }
        self.apply(&Value::Object(layer));
        managed
    }

    /// The row's candidate names, by row key (`FIELD_KEYS`, then `eventSize`, `subSize`).
    pub fn row(&self, key: &str) -> &[String] {
        match key {
            "tag" => &self.tag,
            "forwarder" => &self.forwarder,
            "sourceHost" => &self.source_host,
            "sourceIp" => &self.source_ip,
            "extra" => &self.extra.fields,
            "eventSize" => &self.event_size,
            "subSize" => &self.sub_size,
            _ => &[],
        }
    }

    pub fn collect_time(&self) -> chrono::NaiveTime {
        super::schedule::parse_hhmm(&self.collect_at).unwrap_or_else(|| chrono::NaiveTime::from_hms_opt(6, 0, 0).unwrap_or_default())
    }
}

fn int(v: Option<&Value>) -> Option<u64> {
    match v? {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// The legacy flat list, as the layer it meant. `None` when there is no list.
pub fn legacy_layer(fields: &Value) -> Option<Value> {
    let all = names(fields)?;
    let (mut tag, mut fwd, mut host, mut ip, mut extra) = (vec![], vec![], vec![], vec![], vec![]);
    for f in all {
        match f.as_str() {
            "tag1" => tag.push(f),
            "fwd_tag" | "fwdtag" => fwd.push(f),
            "src_hostname" => host.push(f),
            "src_ip" => ip.push(f),
            _ => extra.push(f),
        }
    }
    let mut m = serde_json::Map::new();
    for (k, v) in [("tag", tag), ("forwarder", fwd), ("sourceHost", host), ("sourceIp", ip)] {
        if !v.is_empty() {
            m.insert(k.into(), json!(v));
        }
    }
    if !extra.is_empty() {
        m.insert("extra".into(), json!({ "fields": extra }));
    }
    Some(Value::Object(m))
}

/// Where the layers came from, for `VOLUME_SETTINGS`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    File,
    Message,
    Builtin,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::File => "file",
            Source::Message => "message",
            Source::Builtin => "builtin",
        }
    }
}

/// The two layers below config.txt, as they were found.
#[derive(Clone, Debug, Default)]
pub struct Layers {
    pub defaults: Value,
    /// `clusters[].volume` (or the message's `cluster`), then the overrides map entry.
    pub cluster: Vec<Value>,
}

/// The layers from a clusters file, for one cluster or none.
pub fn layers_from_config(raw: &Value, cluster_id: Option<&str>) -> Layers {
    let d = raw.get("defaults").cloned().unwrap_or(Value::Null);
    let defaults = match d.get("volume") {
        Some(v) if v.is_object() => v.clone(),
        _ => d.get("volumeFields").or_else(|| d.get("volume_fields")).and_then(legacy_layer).unwrap_or(Value::Null),
    };
    let mut cluster = vec![];
    if let Some(id) = cluster_id {
        let entry = raw.get("clusters").and_then(Value::as_array)
            .and_then(|cs| cs.iter().find(|c| c.get("id").and_then(Value::as_str) == Some(id)));
        let own = entry.and_then(|c| c.get("volume")).filter(|v| v.is_object()).cloned();
        let over = defaults.get("overrides").and_then(|o| o.get(id)).filter(|v| v.is_object()).cloned();
        if own.is_none() && over.is_none() {
            if let Some(l) = entry.and_then(|c| c.get("volumeFields").or_else(|| c.get("volume_fields"))).and_then(legacy_layer) {
                cluster.push(l);
            }
        }
        cluster.extend(own);
        cluster.extend(over);
    }
    Layers { defaults, cluster }
}

/// The layers from a message's `volume: {defaults, cluster}` (desktop: no config file).
/// Without `cluster`, the defaults' own overrides map is consulted, as in a file.
pub fn layers_from_message(v: &Value, cluster_id: Option<&str>) -> Layers {
    let defaults = v.get("defaults").filter(|d| d.is_object()).cloned().unwrap_or(Value::Null);
    let mut cluster = vec![];
    match v.get("cluster").filter(|c| c.is_object()) {
        Some(c) => cluster.push(c.clone()),
        None => {
            if let Some(o) = cluster_id.and_then(|id| defaults.get("overrides").and_then(|o| o.get(id))).filter(|o| o.is_object()) {
                cluster.push(o.clone());
            }
        }
    }
    Layers { defaults, cluster }
}

/// Every cluster id a clusters file gives its own volume settings.
pub fn override_ids(raw: &Value) -> Vec<String> {
    let mut ids: Vec<String> = raw.pointer("/defaults/volume/overrides").and_then(Value::as_object)
        .map(|o| o.keys().cloned().collect()).unwrap_or_default();
    for c in raw.get("clusters").and_then(Value::as_array).into_iter().flatten() {
        if c.get("volume").is_some_and(Value::is_object) {
            if let Some(id) = c.get("id").and_then(Value::as_str) {
                ids.push(id.to_string());
            }
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

/// All four layers, resolved. Returns the settings and the managed names.
pub fn resolve(layers: &Layers, managed: &crate::settings::Settings) -> (VolumeSettings, Vec<&'static str>) {
    let mut s = VolumeSettings::default();
    s.apply(&layers.defaults);
    for l in &layers.cluster {
        s.apply(l);
    }
    let m = s.apply_managed(managed);
    (s, m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Settings;

    #[test]
    fn built_in_is_the_contract() {
        let s = VolumeSettings::default();
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["indexFormat"], "logstash-*-YYYY.MM.DD");
        assert_eq!(v["extra"], json!({ "name": "Dataset", "fields": ["event.dataset", "log_type"] }));
        assert_eq!(v["sizeBasis"], "primary");
        assert_eq!((v["topValues"].as_u64(), v["keepMonths"].as_u64()), (Some(25), Some(13)));
        assert_eq!(v["collectAt"], "06:00");
        assert_eq!(v["sourceIp"], json!(["src_ip", "source.ip", "host.ip"]));
    }

    #[test]
    fn precedence_builtin_defaults_cluster_config_txt() {
        let raw = json!({
            "defaults": { "volume": {
                "forwarder": ["fwd_a"], "topValues": 40, "sizeBasis": "total", "collectAt": "05:30",
                "overrides": { "prod-eu": { "forwarder": ["fwdtag"], "keepMonths": 6 } },
            } },
            "clusters": [ { "id": "prod-eu", "volume": { "forwarder": ["from_cluster"], "topValues": 50 } } ],
        });
        let none = Settings::default();
        let (d, m) = resolve(&layers_from_config(&raw, None), &none);
        assert!(m.is_empty());
        assert_eq!(d.forwarder, vec!["fwd_a"]);
        assert_eq!(d.top_values, 40);
        assert_eq!(d.tag, VolumeSettings::default().tag, "a key no layer sets stays built-in");

        let (c, _) = resolve(&layers_from_config(&raw, Some("prod-eu")), &none);
        assert_eq!(c.forwarder, vec!["fwdtag"], "the overrides map is laid over clusters[].volume");
        assert_eq!(c.top_values, 50, "clusters[].volume counts like an override");
        assert_eq!(c.keep_months, 6);
        assert_eq!(c.size_basis, SizeBasis::Total, "from defaults");

        let txt = Settings::parse("UI_VOLUME_FORWARDER_FIELDS=a, b\nUI_VOLUME_SIZE_BASIS=eventSize\nUI_VOLUME_EXTRA_NAME=Kind\nUI_VOLUME_TOP_VALUES=10\n");
        let (t, managed) = resolve(&layers_from_config(&raw, Some("prod-eu")), &txt);
        assert_eq!(t.forwarder, vec!["a", "b"], "config.txt beats every layer");
        assert_eq!(t.size_basis, SizeBasis::EventSize);
        assert_eq!(t.extra.name, "Kind");
        assert_eq!(t.extra.fields, VolumeSettings::default().extra.fields);
        assert_eq!(t.top_values, 10);
        assert_eq!(managed, vec!["volumeForwarder", "volumeExtraName", "volumeSizeBasis", "volumeTopValues"]);
    }

    #[test]
    fn values_that_do_not_fit_leave_the_layer_below() {
        let mut s = VolumeSettings::default();
        s.apply(&json!({ "indexFormat": "logstash-YYYY.MM.DD", "topValues": 1000, "keepMonths": 0,
                         "sizeBasis": "bytes", "collectAt": "6am", "tag": [], "forwarder": "" }));
        assert_eq!(s, VolumeSettings::default());
        s.apply(&json!({ "indexFormat": "a-*-b,c-YYYY.MM.DD" }));
        assert_eq!(s.index_format, VolumeSettings::default().index_format, "one pattern only");
        s.apply(&json!({ "tag": "x, y ,,", "topValues": "30", "keepMonths": 36 }));
        assert_eq!(s.tag, vec!["x", "y"], "a comma string is a list too");
        assert_eq!((s.top_values, s.keep_months), (30, 36));
    }

    #[test]
    fn legacy_volume_fields_become_rows_only_without_volume() {
        let raw = json!({
            "defaults": { "volumeFields": ["tag1", "fwd_tag", "fwdtag", "src_hostname", "app_name"] },
            "clusters": [
                { "id": "old", "volumeFields": "src_ip, kind" },
                { "id": "new", "volumeFields": ["tag1"], "volume": { "tag": ["labels.tag1"] } },
            ],
        });
        let none = Settings::default();
        let (d, _) = resolve(&layers_from_config(&raw, None), &none);
        assert_eq!(d.tag, vec!["tag1"]);
        assert_eq!(d.forwarder, vec!["fwd_tag", "fwdtag"]);
        assert_eq!(d.source_host, vec!["src_hostname"]);
        assert_eq!(d.source_ip, VolumeSettings::default().source_ip, "not named: built-in");
        assert_eq!(d.extra.fields, vec!["app_name"], "the rest is the extra row");
        let (old, _) = resolve(&layers_from_config(&raw, Some("old")), &none);
        assert_eq!(old.source_ip, vec!["src_ip"]);
        assert_eq!(old.extra.fields, vec!["kind"]);
        let (new, _) = resolve(&layers_from_config(&raw, Some("new")), &none);
        assert_eq!(new.tag, vec!["labels.tag1"], "volume is set: volumeFields is not read");

        // defaults.volume present: the legacy defaults list is not read.
        let both = json!({ "defaults": { "volume": { "sizeBasis": "total" }, "volumeFields": ["app"] } });
        let (b, _) = resolve(&layers_from_config(&both, None), &none);
        assert_eq!(b.extra.fields, VolumeSettings::default().extra.fields);
    }

    #[test]
    fn the_message_carries_defaults_and_one_override() {
        let msg = json!({ "defaults": { "topValues": 30, "overrides": { "a": { "topValues": 60 } } }, "cluster": { "keepMonths": 3 } });
        let (s, _) = resolve(&layers_from_message(&msg, Some("a")), &Settings::default());
        assert_eq!((s.top_values, s.keep_months), (30, 3), "an explicit cluster layer replaces the map lookup");
        let msg = json!({ "defaults": { "topValues": 30, "overrides": { "a": { "topValues": 60 } } } });
        let (s, _) = resolve(&layers_from_message(&msg, Some("a")), &Settings::default());
        assert_eq!(s.top_values, 60);
        assert_eq!(override_ids(&json!({ "defaults": { "volume": { "overrides": { "b": {}, "a": {} } } },
                                         "clusters": [{ "id": "c", "volume": {} }, { "id": "d" }] })), vec!["a", "b", "c"]);
    }

    #[test]
    fn index_format_rules() {
        assert_eq!(index_format_problem("logstash-*-YYYY.MM.DD"), None);
        assert_eq!(index_format_problem("logs-*-YYYY.MM.DD-000001"), None);
        assert!(index_format_problem("logstash-YYYY.MM.DD").is_some());
        assert!(index_format_problem("logstash-*").is_some());
        assert!(index_format_problem("a-*-YYYY.MM.DD-YYYY.MM.DD").is_some());
        assert!(index_format_problem("a *-YYYY.MM.DD").is_some());
    }
}
