//! Saved REST console queries: named requests a person keeps, privately or shared with the
//! team — on the server (`<data dir>/saved-queries.json`, 0600), not in the browser.
//!
//! The page redacts password, token and key fields (and URL credentials) before it sends a
//! query here (ui/js/lib/redact.js), so a shared query never hands a teammate a secret. A
//! person sees their own queries and every shared one; only the owner (or an administrator)
//! changes or deletes one.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const MAX_PER_USER: usize = 500;
pub const MAX_BODY: usize = 256 * 1024;
const METHODS: [&str; 6] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: String,
    pub owner: String,
    pub name: String,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub shared: bool,
    #[serde(default)]
    pub note: String,
    pub at: u64,
    pub updated: u64,
}

pub struct SavedQueries {
    path: Option<PathBuf>,
    list: RwLock<Vec<SavedQuery>>,
}

/// What a save asks for.
pub struct Draft<'a> {
    pub id: Option<&'a str>,
    pub name: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub body: &'a str,
    pub shared: bool,
    pub note: &'a str,
}

impl SavedQueries {
    pub fn open(path: Option<PathBuf>) -> SavedQueries {
        let list = path.as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Vec<SavedQuery>>(&s).ok())
            .unwrap_or_default();
        SavedQueries { path, list: RwLock::new(list) }
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
            let mut f = o.open(&tmp).map_err(|e| format!("saved-queries.json.tmp: {e}"))?;
            f.write_all(&body).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, p).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("saved-queries.json: {e}")
        })
    }

    /// The caller's own queries and every shared one, newest first.
    pub fn visible_to(&self, user: &str) -> Vec<SavedQuery> {
        let mut v: Vec<SavedQuery> = self.list.read().iter()
            .filter(|q| q.shared || q.owner.eq_ignore_ascii_case(user)).cloned().collect();
        v.sort_by(|a, b| b.updated.cmp(&a.updated));
        v
    }

    /// Create, or update one the caller owns (an administrator may update any).
    pub fn put(&self, user: &str, admin: bool, d: Draft) -> Result<SavedQuery, String> {
        let name = d.name.trim();
        if name.is_empty() || name.chars().count() > 120 {
            return Err("a saved query needs a name (at most 120 characters)".into());
        }
        let method = d.method.trim().to_ascii_uppercase();
        if !METHODS.contains(&method.as_str()) {
            return Err(format!("method must be one of {}", METHODS.join(", ")));
        }
        let path = d.path.trim();
        if path.is_empty() || path.len() > 4096 {
            return Err("a path is needed (at most 4096 characters)".into());
        }
        if d.body.len() > MAX_BODY {
            return Err(format!("the body is larger than {} KB", MAX_BODY / 1024));
        }
        let now = crate::fleet::now_ms();
        let mut l = self.list.write();
        let out = match d.id.filter(|s| !s.is_empty()) {
            Some(id) => {
                let q = l.iter_mut().find(|q| q.id == id).ok_or("no such saved query")?;
                if !(admin || q.owner.eq_ignore_ascii_case(user)) {
                    return Err("only its owner (or an administrator) can change a saved query".into());
                }
                q.name = name.into();
                q.method = method;
                q.path = path.into();
                q.body = d.body.into();
                q.shared = d.shared;
                q.note = d.note.trim().chars().take(500).collect();
                q.updated = now;
                q.clone()
            }
            None => {
                if l.iter().filter(|q| q.owner.eq_ignore_ascii_case(user)).count() >= MAX_PER_USER {
                    return Err(format!("{MAX_PER_USER} saved queries already — delete some first"));
                }
                let q = SavedQuery {
                    id: crate::auth::random_hex(6), owner: user.into(), name: name.into(), method,
                    path: path.into(), body: d.body.into(), shared: d.shared,
                    note: d.note.trim().chars().take(500).collect(), at: now, updated: now,
                };
                l.push(q.clone());
                q
            }
        };
        drop(l);
        self.save()?;
        Ok(out)
    }

    pub fn delete(&self, user: &str, admin: bool, id: &str) -> Result<SavedQuery, String> {
        let gone = {
            let mut l = self.list.write();
            let i = l.iter().position(|q| q.id == id).ok_or("no such saved query")?;
            if !(admin || l[i].owner.eq_ignore_ascii_case(user)) {
                return Err("only its owner (or an administrator) can delete a saved query".into());
            }
            l.remove(i)
        };
        self.save()?;
        Ok(gone)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d<'a>(name: &'a str, shared: bool) -> Draft<'a> {
        Draft { id: None, name, method: "get", path: "/_cat/indices?v", body: "", shared, note: "" }
    }

    #[test]
    fn own_and_shared_are_visible_only_the_owner_changes_kept_across_a_restart() {
        let dir = std::env::temp_dir().join(format!("ep-sq-{}-{}", std::process::id(), crate::auth::random_hex(3)));
        let p = dir.join("saved-queries.json");
        let s = SavedQueries::open(Some(p.clone()));
        let mine = s.put("sara", false, d("disk check", false)).unwrap();
        let shared = s.put("sara", false, d("team: shards", true)).unwrap();
        assert_eq!(mine.method, "GET", "method upper-cased");
        assert_eq!(s.visible_to("omar").iter().map(|q| q.name.as_str()).collect::<Vec<_>>(), vec!["team: shards"]);
        assert_eq!(s.visible_to("SARA").len(), 2, "owner matched without case");
        assert!(s.put("omar", false, Draft { id: Some(&shared.id), ..d("hijack", true) }).is_err(), "not the owner");
        assert!(s.delete("omar", false, &shared.id).is_err());
        assert!(s.put("root", true, Draft { id: Some(&shared.id), ..d("renamed by admin", true) }).is_ok());
        let again = SavedQueries::open(Some(p.clone()));
        assert_eq!(again.visible_to("sara").len(), 2, "kept across a restart");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        again.delete("sara", false, &mine.id).unwrap();
        assert_eq!(again.visible_to("sara").len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bounds() {
        let s = SavedQueries::open(None);
        assert!(s.put("a", false, d(" ", false)).is_err());
        assert!(s.put("a", false, Draft { method: "BREW", ..d("x", false) }).is_err());
        assert!(s.put("a", false, Draft { path: "", ..d("x", false) }).is_err());
        let big = "x".repeat(MAX_BODY + 1);
        assert!(s.put("a", false, Draft { body: &big, ..d("x", false) }).is_err());
    }
}
