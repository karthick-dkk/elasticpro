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
//! top, because the map is what the editor writes. A `clusters[]` entry has no `id`; it is
//! found by the id the UI primes it under (`cluster_save::config_ids`). config.txt locks its rows everywhere,
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

/// Where an index's day comes from (docs/VOLUME.md "What counts").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DayFrom {
    /// An index whose name carries `YYYY.MM.DD` counts on that day in full; one without a
    /// date in its name is split into days by its documents' time field.
    #[default]
    Name,
    /// Every index is split into days by its documents' time field.
    Time,
}

impl DayFrom {
    pub fn parse(s: &str) -> Option<DayFrom> {
        match s.trim().to_ascii_lowercase().as_str() {
            "name" => Some(DayFrom::Name),
            "time" => Some(DayFrom::Time),
            _ => None,
        }
    }
}

/// Which of the two ways of naming the indices is in force, for the settings page: the
/// legacy `indexFormat` (set at a later layer than any `indexPattern`), an `indexPattern`
/// somebody set, or the built-in pattern.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PatternSource {
    Format,
    Pattern,
    #[default]
    Default,
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
    /// The legacy index-name format (`logstash-*-YYYY.MM.DD`). In force only when
    /// `pattern_source` is `Format`.
    pub index_format: String,
    /// One or more comma-separated index patterns (`logstash-*`), no date part needed.
    pub index_pattern: String,
    pub day_from: DayFrom,
    /// The documents' time field, for the indices split into days by time.
    pub time_field: String,
    /// Which of `index_format` / `index_pattern` decides what counts. Worked out by `apply`
    /// (the later layer that sets either wins; one layer setting both: the pattern).
    pub pattern_source: PatternSource,
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
            index_pattern: "logstash-*".into(),
            day_from: DayFrom::Name,
            time_field: "@timestamp".into(),
            pattern_source: PatternSource::Default,
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
    ("UI_VOLUME_INDEX_PATTERN", "indexPattern", "volumeIndexPattern"),
    ("UI_VOLUME_DAY_FROM", "dayFrom", "volumeDayFrom"),
    ("UI_VOLUME_TIME_FIELD", "timeField", "volumeTimeField"),
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

/// The most patterns one `indexPattern` may list.
pub const MAX_PATTERNS: usize = 20;

/// The patterns of an `indexPattern`, trimmed.
pub fn split_patterns(p: &str) -> Vec<String> {
    p.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect()
}

/// Why an `indexPattern` cannot be used, if it cannot. One or more comma-separated
/// patterns, each an index name, alias, data stream or wildcard pattern as Elasticsearch
/// takes it in a path; a later one may exclude (`logstash-*,-logstash-test-*`). No date
/// part is needed.
pub fn index_pattern_problem(p: &str) -> Option<String> {
    if p.trim().is_empty() {
        return Some("names no index pattern".into());
    }
    if p.split(',').any(|s| s.trim().is_empty()) {
        return Some("has an empty pattern between commas".into());
    }
    let parts = split_patterns(p);
    if parts.len() > MAX_PATTERNS {
        return Some(format!("lists more than {MAX_PATTERNS} patterns"));
    }
    for (i, x) in parts.iter().enumerate() {
        let body = match x.strip_prefix('-') {
            Some(rest) if i > 0 => rest,
            Some(_) => return Some(format!("{x:?}: the first pattern cannot be an exclusion")),
            None => x.as_str(),
        };
        if body.is_empty() || body.len() > 255 {
            return Some(format!("{x:?}: a pattern is 1 to 255 characters"));
        }
        if body.starts_with(['_', '+', '-']) {
            return Some(format!("{x:?}: an index name cannot start with _, + or -"));
        }
        if body.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, '/' | '\\' | '?' | '#' | '"' | '<' | '>' | '|' | ':')) {
            return Some(format!("{x:?}: no spaces, slashes, quotes, ?, #, <, >, | or :"));
        }
    }
    None
}

/// Why a `timeField` cannot be used, if it cannot: it is one field name.
pub fn time_field_problem(f: &str) -> Option<&'static str> {
    if f.is_empty() || f.len() > 255 || f.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, ',' | '"' | '*')) {
        return Some("must be one field name: no spaces, commas, quotes or *");
    }
    None
}

impl VolumeSettings {
    /// Lay one layer over this one. Unknown keys and values that do not fit are ignored.
    ///
    /// `indexPattern` and the legacy `indexFormat`: whichever the later layer sets is in
    /// force (`pattern_source`); a layer that sets both means the pattern.
    pub fn apply(&mut self, layer: &Value) {
        let Some(m) = layer.as_object() else { return };
        if let Some(f) = m.get("indexFormat").and_then(Value::as_str).map(str::trim) {
            if index_format_problem(f).is_none() {
                self.index_format = f.to_string();
                self.pattern_source = PatternSource::Format;
            }
        }
        if let Some(p) = m.get("indexPattern").and_then(Value::as_str) {
            if index_pattern_problem(p).is_none() {
                self.index_pattern = split_patterns(p).join(",");
                self.pattern_source = PatternSource::Pattern;
            }
        }
        if let Some(d) = m.get("dayFrom").and_then(Value::as_str).and_then(DayFrom::parse) {
            self.day_from = d;
        }
        if let Some(t) = m.get("timeField").and_then(Value::as_str).map(str::trim) {
            if time_field_problem(t).is_none() {
                self.time_field = t.to_string();
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
    /// `clusters[].volume` (or the message's cluster override), then the overrides map entry.
    pub cluster: Vec<Value>,
}

/// A level's legacy flat list, whichever spelling it uses.
fn legacy_of(level: &Value) -> Option<&Value> {
    level.get("volumeFields").or_else(|| level.get("volume_fields"))
}

/// **One level** — the defaults, or one cluster — as the layer it means: its `volume`
/// object when it has one, else its legacy `volumeFields` list converted (`legacy_layer`).
/// The one conversion, for the clusters file and the desktop message alike.
pub fn level_layer(volume: Option<&Value>, legacy: Option<&Value>) -> Option<Value> {
    match volume.filter(|v| v.is_object()) {
        Some(v) => Some(v.clone()),
        None => legacy.and_then(legacy_layer),
    }
}

/// The layers from a clusters file, for one cluster or none. A cluster's entry is found by
/// the id the UI gives it (`cluster_save::config_ids`): file entries carry no `id`.
pub fn layers_from_config(raw: &Value, cluster_id: Option<&str>) -> Layers {
    let d = raw.get("defaults").cloned().unwrap_or(Value::Null);
    let defaults = level_layer(d.get("volume"), legacy_of(&d)).unwrap_or(Value::Null);
    let mut cluster = vec![];
    if let Some(id) = cluster_id {
        let list = crate::cluster_save::config_entries(raw);
        let entry = crate::cluster_save::config_ids(list).iter().position(|x| x == id).and_then(|i| list.get(i));
        let over = defaults.get("overrides").and_then(|o| o.get(id)).filter(|v| v.is_object()).cloned();
        // The legacy list counts only where the cluster has no `volume` of either kind.
        let own = entry.and_then(|c| level_layer(c.get("volume"), if over.is_some() { None } else { legacy_of(c) }));
        cluster.extend(own);
        cluster.extend(over);
    }
    Layers { defaults, cluster }
}

/// One level of a desktop message as its layer. The UI sends `defaults.volume` and the
/// overrides as saved (volume objects); a level sent whole (`{volume, volumeFields}`) or a
/// legacy list alone (`{volumeFields}`) is read as the file's would be: `level_layer`.
fn message_level(m: &Value) -> Option<Value> {
    let o = m.as_object()?;
    if o.get("volume").is_some_and(Value::is_object) {
        return level_layer(o.get("volume"), legacy_of(m));
    }
    let settings = o.keys().any(|k| !matches!(k.as_str(), "volumeFields" | "volume_fields" | "overrides"));
    let mut layer = level_layer(settings.then_some(m), legacy_of(m)).unwrap_or_else(|| json!({}));
    if let (Some(over), Some(l)) = (o.get("overrides"), layer.as_object_mut()) {
        l.entry("overrides").or_insert_with(|| over.clone());
    }
    Some(layer)
}

/// The layers from a message's `volume: {defaults, cluster, clusters}` (desktop: no config
/// file). A cluster's override is `clusters[id]` when the message has one for it — what
/// `VOLUME_RUN`, `VOLUME_MONTHLY_ALL` and a report over several clusters carry — else, when
/// the message is about this one cluster (`own`: its `clusterId`), `cluster`. Neither: the
/// defaults' own overrides map, as in a file. `cluster` never applies to another cluster.
pub fn layers_from_message(v: &Value, cluster_id: Option<&str>, own: bool) -> Layers {
    let defaults = v.get("defaults").and_then(message_level).unwrap_or(Value::Null);
    let mut cluster = vec![];
    let explicit = v.get("cluster").filter(|c| own && c.is_object());
    let mapped = || cluster_id.and_then(|id| v.get("clusters").and_then(|m| m.get(id))).filter(|c| c.is_object());
    match mapped().or(explicit) {
        Some(c) => cluster.extend(message_level(c)),
        None => {
            if let Some(o) = cluster_id.and_then(|id| defaults.get("overrides").and_then(|o| o.get(id))).filter(|o| o.is_object()) {
                cluster.push(o.clone());
            }
        }
    }
    Layers { defaults, cluster }
}

/// Every cluster id a desktop message gives its own volume settings.
pub fn message_override_ids(v: &Value) -> Vec<String> {
    let defaults = v.get("defaults").and_then(message_level).unwrap_or(Value::Null);
    let mut ids: Vec<String> = defaults.get("overrides").and_then(Value::as_object).map(|o| o.keys().cloned().collect()).unwrap_or_default();
    ids.extend(v.get("clusters").and_then(Value::as_object).into_iter().flatten()
        .filter(|(_, c)| c.as_object().is_some_and(|o| !o.is_empty())).map(|(k, _)| k.clone()));
    ids.sort();
    ids.dedup();
    ids
}

/// Every cluster id a clusters file gives its own volume settings: the overrides map, and
/// each entry with a `volume` or a legacy `volumeFields`, by the id the UI gives it.
pub fn override_ids(raw: &Value) -> Vec<String> {
    let mut ids: Vec<String> = raw.pointer("/defaults/volume/overrides").and_then(Value::as_object)
        .map(|o| o.keys().cloned().collect()).unwrap_or_default();
    let list = crate::cluster_save::config_entries(raw);
    for (c, id) in list.iter().zip(crate::cluster_save::config_ids(list)) {
        if level_layer(c.get("volume"), legacy_of(c)).is_some() {
            ids.push(id);
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
            "clusters": [ { "name": "Prod EU", "url": "https://es-eu:9200", "volume": { "forwarder": ["from_cluster"], "topValues": 50 } } ],
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
                { "name": "old", "url": "https://old:9200", "volumeFields": "src_ip, kind" },
                { "name": "new", "url": "https://new:9200", "volumeFields": ["tag1"], "volume": { "tag": ["labels.tag1"] } },
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
        let (s, _) = resolve(&layers_from_message(&msg, Some("a"), true), &Settings::default());
        assert_eq!((s.top_values, s.keep_months), (30, 3), "an explicit cluster layer replaces the map lookup");
        let msg = json!({ "defaults": { "topValues": 30, "overrides": { "a": { "topValues": 60 } } } });
        let (s, _) = resolve(&layers_from_message(&msg, Some("a"), true), &Settings::default());
        assert_eq!(s.top_values, 60);
        assert_eq!(override_ids(&json!({ "defaults": { "volume": { "overrides": { "b": {}, "a": {} } } },
                                         "clusters": [{ "name": "c", "url": "https://c", "volume": {} },
                                                      { "name": "d", "url": "https://d" },
                                                      { "name": "E e", "url": "https://e", "volumeFields": ["x"] }] })),
                   vec!["a", "b", "c", "e-e"], "a legacy list is a cluster's own settings too");
    }

    /// A hand-written hosted entry has no `id`: it is found by the id the UI primes it under.
    #[test]
    fn a_clusters_file_entry_is_found_by_the_ui_id() {
        let raw = json!({
            "defaults": { "volume": { "topValues": 40 } },
            "clusters": [
                { "name": "Prod EU", "url": "https://es-eu:9200", "volume": { "forwarder": ["fwdtag"] } },
                { "name": "prod eu", "url": "https://es-eu2:9200", "volume": { "forwarder": ["second"] } },
                { "url": "https://legacy.example:9200", "volumeFields": ["tag1", "kind"] },
            ],
        });
        let none = Settings::default();
        let (eu, _) = resolve(&layers_from_config(&raw, Some("prod-eu")), &none);
        assert_eq!(eu.forwarder, vec!["fwdtag"]);
        assert_eq!(eu.top_values, 40, "defaults still under it");
        let (eu2, _) = resolve(&layers_from_config(&raw, Some("prod-eu-1")), &none);
        assert_eq!(eu2.forwarder, vec!["second"], "a colliding name gets the UI's position suffix");
        let (legacy, _) = resolve(&layers_from_config(&raw, Some("legacy-example-9200")), &none);
        assert_eq!((legacy.tag.clone(), legacy.extra.fields.clone()), (vec!["tag1".to_string()], vec!["kind".to_string()]),
                   "per-cluster volumeFields, found by the URL host's slug");
        assert_eq!(override_ids(&raw), vec!["legacy-example-9200", "prod-eu", "prod-eu-1"]);
        let (other, _) = resolve(&layers_from_config(&raw, Some("nope")), &none);
        assert_eq!(other.forwarder, VolumeSettings::default().forwarder);
    }

    /// Desktop messages about several clusters carry each one's override in `clusters`, and
    /// a legacy list in the message is converted as the file's is.
    #[test]
    fn a_message_about_several_clusters_uses_each_ones_override() {
        let msg = json!({
            "defaults": { "topValues": 30, "overrides": { "c": { "topValues": 70 } } },
            "cluster": { "topValues": 99 },
            "clusters": { "a": { "topValues": 50 }, "b": { "volumeFields": ["fwdtag", "kind"] } },
        });
        let s = |id: &str, own: bool| resolve(&layers_from_message(&msg, Some(id), own), &Settings::default()).0;
        assert_eq!(s("a", false).top_values, 50, "clusters[id]");
        assert_eq!(s("a", true).top_values, 50, "keyed by id beats the unkeyed `cluster`");
        assert_eq!(s("d", true).top_values, 99, "a message about this cluster, nothing keyed: its `cluster`");
        assert_eq!(s("b", false).forwarder, vec!["fwdtag"], "a legacy list in clusters[id] is converted");
        assert_eq!(s("b", false).extra.fields, vec!["kind"]);
        assert_eq!(s("b", false).top_values, 30);
        assert_eq!(s("c", false).top_values, 70, "no entry: the defaults' overrides map");
        assert_eq!(s("d", false).top_values, 30, "and not another cluster's `cluster`");
        assert_eq!(message_override_ids(&msg), vec!["a", "b", "c"]);
        // Legacy defaults, as a level sent whole or as a list alone.
        let legacy = json!({ "defaults": { "volumeFields": ["tag1", "src_ip", "app"], "overrides": { "x": { "topValues": 10 } } } });
        let (d, _) = resolve(&layers_from_message(&legacy, Some("x"), false), &Settings::default());
        assert_eq!((d.tag.clone(), d.source_ip.clone(), d.extra.fields.clone(), d.top_values),
                   (vec!["tag1".to_string()], vec!["src_ip".to_string()], vec!["app".to_string()], 10));
        let whole = json!({ "defaults": { "volume": { "sizeBasis": "total" }, "volumeFields": ["app"] } });
        let (w, _) = resolve(&layers_from_message(&whole, None, false), &Settings::default());
        assert_eq!((w.size_basis, w.extra.fields.clone()), (SizeBasis::Total, VolumeSettings::default().extra.fields),
                   "volume set: the legacy list is not read, as in the file");
    }

    /// `indexPattern` (default `logstash-*`) and the legacy `indexFormat`: the later layer
    /// wins, config.txt last; one layer with both means the pattern. `patternSource` says
    /// which is in force.
    #[test]
    fn the_pattern_or_the_legacy_format_whichever_the_later_layer_sets() {
        let none = Settings::default();
        let d = VolumeSettings::default();
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!((v["indexPattern"].as_str(), v["dayFrom"].as_str(), v["timeField"].as_str(), v["patternSource"].as_str()),
                   (Some("logstash-*"), Some("name"), Some("@timestamp"), Some("default")));
        // A clusters file that names only the format: exactly as before 0.3.53.
        let fmt = json!({ "defaults": { "volume": { "indexFormat": "logs-*-YYYY.MM.DD" } } });
        let (s, _) = resolve(&layers_from_config(&fmt, None), &none);
        assert_eq!((s.pattern_source, s.index_format.as_str()), (PatternSource::Format, "logs-*-YYYY.MM.DD"));
        // A pattern in a cluster override beats the defaults' format; in the same layer as a
        // format, the pattern wins.
        let both = json!({ "defaults": { "volume": { "indexFormat": "logs-*-YYYY.MM.DD",
                                                     "overrides": { "a": { "indexPattern": "app-*, web-*" } } } } });
        let (a, _) = resolve(&layers_from_config(&both, Some("a")), &none);
        assert_eq!((a.pattern_source, a.index_pattern.as_str()), (PatternSource::Pattern, "app-*,web-*"));
        let mut one = VolumeSettings::default();
        one.apply(&json!({ "indexFormat": "logs-*-YYYY.MM.DD", "indexPattern": "logs-*" }));
        assert_eq!(one.pattern_source, PatternSource::Pattern);
        // config.txt: UI_VOLUME_INDEX_FORMAT alone is the legacy behaviour, with the pattern
        // too the pattern; either beats the file.
        let txt = Settings::parse("UI_VOLUME_INDEX_FORMAT=old-*-YYYY.MM.DD\n");
        let (t, managed) = resolve(&layers_from_config(&both, Some("a")), &txt);
        assert_eq!((t.pattern_source, t.index_format.as_str()), (PatternSource::Format, "old-*-YYYY.MM.DD"));
        assert_eq!(managed, vec!["volumeIndexFormat"]);
        let txt = Settings::parse("UI_VOLUME_INDEX_FORMAT=old-*-YYYY.MM.DD\nUI_VOLUME_INDEX_PATTERN=new-*\nUI_VOLUME_DAY_FROM=TIME\nUI_VOLUME_TIME_FIELD=event.created\n");
        assert!(txt.warnings().is_empty(), "{:?}", txt.warnings());
        let (t, managed) = resolve(&layers_from_config(&fmt, None), &txt);
        assert_eq!((t.pattern_source, t.index_pattern.as_str(), t.day_from, t.time_field.as_str()),
                   (PatternSource::Pattern, "new-*", DayFrom::Time, "event.created"));
        assert_eq!(managed, vec!["volumeIndexFormat", "volumeIndexPattern", "volumeDayFrom", "volumeTimeField"]);
        // Values that do not fit leave the layer below.
        let mut s = VolumeSettings::default();
        s.apply(&json!({ "indexPattern": "a,,b", "dayFrom": "never", "timeField": "a b" }));
        assert_eq!(s, VolumeSettings::default());
        let bad = Settings::parse("UI_VOLUME_INDEX_PATTERN=_all\nUI_VOLUME_DAY_FROM=sometimes\nUI_VOLUME_TIME_FIELD=a,b\n");
        assert_eq!(bad.warnings().len(), 3, "{:?}", bad.warnings());
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
