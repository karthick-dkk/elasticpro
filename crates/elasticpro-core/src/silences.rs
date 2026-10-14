//! Alert silences: a cluster in maintenance, or one known problem, kept out of the open
//! alert counts until a time an operator chose — shared by everyone, kept on the server.
//!
//! On a fleet of a hundred clusters some are always being worked on, and the only ways to
//! quiet them were to switch a rule off for the whole fleet or to acknowledge each alert
//! on each machine (acknowledgements live in that browser only). A silence is the team's
//! decision, so it lives here: `<data dir>/silences.json`, 0600, with who set it, why, and
//! until when. A silenced alert is still listed on the Alerts page, under "Silenced"; it
//! is only left out of the counts. Nothing silences itself, and every silence ends — "until
//! removed" is the longest, and says so.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The longest a timed silence may run: past a week it is a rule that should be switched
/// off on purpose, not forgotten in a list.
pub const MAX_MINUTES: u64 = 7 * 24 * 60;
/// Stops one runaway script filling the file.
pub const MAX_SILENCES: usize = 2000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Silence {
    pub id: String,
    /// "cluster": every alert of that cluster; "alert": one alert key.
    pub scope: String,
    /// The cluster id, or the alert key.
    pub target: String,
    pub reason: String,
    pub by: String,
    pub at: u64,
    /// Unix ms; `None` = until somebody removes it.
    pub until: Option<u64>,
}

impl Silence {
    pub fn live(&self, now: u64) -> bool {
        self.until.is_none_or(|u| u > now)
    }
}

/// The cluster a silence is about, among `known` cluster ids: its target for a cluster
/// silence; for an alert silence, the cluster whose id the key starts with followed by ':'
/// (keys are `<clusterId>:<family>…`) — the LONGEST such id, so a cluster id that itself
/// contains ':' cannot be mistaken for a shorter one the caller happens to see. None when no
/// known cluster owns the target: refused, never guessed.
pub fn cluster_of<'a>(scope: &str, target: &str, known: impl IntoIterator<Item = &'a String>) -> Option<&'a String> {
    let target = target.trim();
    if scope == "alert" {
        known.into_iter().filter(|id| target.len() > id.len() && target.starts_with(id.as_str()) && target.as_bytes()[id.len()] == b':')
            .max_by_key(|id| id.len())
    } else {
        known.into_iter().find(|id| id.as_str() == target)
    }
}

pub struct Silences {
    path: Option<PathBuf>,
    list: RwLock<Vec<Silence>>,
}

fn now_ms() -> u64 {
    crate::fleet::now_ms()
}

impl Silences {
    pub fn open(path: Option<PathBuf>) -> Silences {
        let list = path.as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Vec<Silence>>(&s).ok())
            .unwrap_or_default();
        Silences { path, list: RwLock::new(list) }
    }

    fn save(&self) -> Result<(), String> {
        let Some(p) = &self.path else { return Ok(()) };
        let body = serde_json::to_vec_pretty(&*self.list.read()).map_err(|e| e.to_string())?;
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        let tmp = p.with_extension("json.tmp");
        let _ = std::fs::remove_file(&tmp);
        {
            use std::io::Write as _;
            let mut o = std::fs::OpenOptions::new();
            o.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                o.mode(0o600);
            }
            let mut f = o.open(&tmp).map_err(|e| format!("silences.json.tmp: {e}"))?;
            f.write_all(&body).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, p).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("silences.json: {e}")
        })
    }

    /// The live silences; expired ones are dropped (and the file rewritten) on the way.
    pub fn list(&self) -> Vec<Silence> {
        let now = now_ms();
        let expired = self.list.read().iter().any(|s| !s.live(now));
        if expired {
            self.list.write().retain(|s| s.live(now));
            let _ = self.save();
        }
        self.list.read().clone()
    }

    /// Add one. `minutes` = None is "until removed". Returns the silence.
    pub fn add(&self, scope: &str, target: &str, minutes: Option<u64>, reason: &str, by: &str) -> Result<Silence, String> {
        if scope != "cluster" && scope != "alert" {
            return Err("scope must be \"cluster\" or \"alert\"".into());
        }
        let target = target.trim();
        if target.is_empty() || target.len() > 512 {
            return Err("target must name a cluster id or an alert key".into());
        }
        let minutes = match minutes {
            Some(0) => return Err("a silence needs a duration — or none, for until it is removed".into()),
            Some(m) if m > MAX_MINUTES => return Err(format!("a timed silence runs at most {} days; longer is \"until removed\"", MAX_MINUTES / 1440)),
            m => m,
        };
        let now = now_ms();
        let s = Silence {
            id: crate::auth::random_hex(6),
            scope: scope.into(),
            target: target.into(),
            reason: reason.trim().chars().take(300).collect(),
            by: by.into(),
            at: now,
            until: minutes.map(|m| now + m * 60_000),
        };
        {
            let mut l = self.list.write();
            l.retain(|x| x.live(now) && !(x.scope == s.scope && x.target == s.target));
            if l.len() >= MAX_SILENCES {
                return Err(format!("{MAX_SILENCES} silences already — remove some first"));
            }
            l.push(s.clone());
        }
        self.save()?;
        Ok(s)
    }

    pub fn remove(&self, id: &str) -> Result<Option<Silence>, String> {
        let gone = {
            let mut l = self.list.write();
            let i = l.iter().position(|s| s.id == id);
            i.map(|i| l.remove(i))
        };
        if gone.is_some() {
            self.save()?;
        }
        Ok(gone)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_silence_is_kept_across_a_restart_and_ends_when_its_time_is_up() {
        let dir = std::env::temp_dir().join(format!("ep-silences-{}-{}", std::process::id(), crate::auth::random_hex(3)));
        let p = dir.join("silences.json");
        let s = Silences::open(Some(p.clone()));
        let a = s.add("cluster", "prod-1", Some(60), "disk swap", "sara").unwrap();
        let b = s.add("alert", "prod-2:disk", None, "", "sara").unwrap();
        assert!(a.until.is_some() && b.until.is_none());
        let again = Silences::open(Some(p.clone()));
        assert_eq!(again.list().len(), 2, "kept across a restart");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // One silence per target: setting it again replaces it.
        again.add("cluster", "prod-1", Some(5), "shorter", "omar").unwrap();
        assert_eq!(again.list().iter().filter(|x| x.target == "prod-1").count(), 1);
        // Expired: gone.
        again.list.write().iter_mut().for_each(|x| if x.target == "prod-1" { x.until = Some(1) });
        assert!(!again.list().iter().any(|x| x.target == "prod-1"));
        assert!(again.remove(&b.id).unwrap().is_some());
        assert!(again.list().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_alert_key_belongs_to_the_longest_cluster_id_it_starts_with() {
        let known = vec!["a".to_string(), "a:b".to_string(), "prod".to_string()];
        assert_eq!(cluster_of("alert", "a:b:disk", &known).map(String::as_str), Some("a:b"), "not the shorter \"a\"");
        assert_eq!(cluster_of("alert", "a:disk", &known).map(String::as_str), Some("a"));
        assert_eq!(cluster_of("alert", "nobody:disk", &known), None);
        assert_eq!(cluster_of("alert", "prod", &known), None, "a bare cluster id is not an alert key");
        assert_eq!(cluster_of("cluster", " prod ", &known).map(String::as_str), Some("prod"));
        assert_eq!(cluster_of("cluster", "pro", &known), None);
    }

    #[test]
    fn bounds() {
        let s = Silences::open(None);
        assert!(s.add("host", "x", Some(5), "", "a").is_err());
        assert!(s.add("cluster", " ", Some(5), "", "a").is_err());
        assert!(s.add("cluster", "x", Some(0), "", "a").is_err());
        assert!(s.add("cluster", "x", Some(MAX_MINUTES + 1), "", "a").is_err());
        assert!(s.add("cluster", "x", Some(MAX_MINUTES), "", "a").is_ok());
    }
}
