//! "Your settings": the few choices a person makes about the app itself — where the page
//! menu sits, the theme, what opens first — kept with the account, so they follow the
//! person to any browser.
//!
//! The theme used to live in each browser's IndexedDB, which meant the laptop and the NOC
//! desk disagreed. This keeps the same three values server-side, per account name, in
//! `<data dir>/user-prefs.json` (0600, tmp + rename); no data dir ⇒ in memory for the life
//! of the process.
//!
//! Like the notification history (`notify.rs`) this is gated by identity, not by the write
//! guard: nothing here touches a cluster, and every call names the caller's own account —
//! the user is never read from the message, so nobody reads or sets anybody else's.
//!
//! A value that was never set is `None` and goes out as `null`: the UI then keeps whatever
//! the browser had (its IndexedDB theme, the shipped layout) rather than being told "system"
//! by a store that was never asked. Unknown is not a default.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// The store's file name in the data directory.
pub const FILE: &str = "user-prefs.json";
/// Stops a runaway script filling the file with made-up account names.
pub const MAX_USERS: usize = 5000;

/// Where the page menu sits.
pub const MENUS: [&str; 2] = ["top", "left"];
/// The themes, as `ui/js/app.js` THEMES names them. One list on each side; the UI's is the
/// one that draws, this one is what the store accepts.
pub const THEMES: [&str; 5] = ["system", "light", "dark", "dark-blue", "warm"];
/// What the app opens on: the cluster last chosen in this browser, or every cluster.
pub const OPENS_ON: [&str; 2] = ["last", "all"];

/// The keys a `PREFS_SET` may carry, with what each accepts.
const FIELDS: [(&str, &[&str]); 3] = [("menu", &MENUS), ("theme", &THEMES), ("opensOn", &OPENS_ON)];

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub menu: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opens_on: Option<String>,
    /// When this person last changed anything here (ms); 0 = never.
    #[serde(default)]
    pub updated_at: u64,
}

impl Prefs {
    /// As the UI receives it: every field present, `null` where nothing was ever set.
    pub fn public(&self) -> Value {
        json!({
            "menu": self.menu,
            "theme": self.theme,
            "opensOn": self.opens_on,
        })
    }

    fn is_empty(&self) -> bool {
        self.menu.is_none() && self.theme.is_none() && self.opens_on.is_none()
    }
}

/// What a `PREFS_GET`/`PREFS_SET` answer offers besides the values: the choices, so a UI
/// never has to guess which spellings the store takes.
pub fn choices() -> Value {
    json!({ "menu": MENUS, "theme": THEMES, "opensOn": OPENS_ON })
}

pub struct UserPrefs {
    path: Option<PathBuf>,
    map: RwLock<BTreeMap<String, Prefs>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl UserPrefs {
    pub fn open(path: Option<PathBuf>) -> UserPrefs {
        let map = path.as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<BTreeMap<String, Prefs>>(&s).ok())
            .unwrap_or_default();
        UserPrefs { path, map: RwLock::new(map) }
    }

    /// This person's settings; `None` when they never set any.
    pub fn get(&self, user: &str) -> Option<Prefs> {
        self.map.read().get(user).cloned()
    }

    /// Apply a patch — `{menu?, theme?, opensOn?}`, each a known spelling or `null` to
    /// unset — and return the result. Keys the store does not know, and values it does not
    /// accept, are refused whole: nothing is saved, so the caller cannot end up with half
    /// a change.
    pub fn set(&self, user: &str, patch: &Value) -> Result<Prefs, String> {
        let user = user.trim();
        if user.is_empty() {
            return Err("no account to keep the settings for".into());
        }
        let Some(obj) = patch.as_object() else {
            return Err("PREFS_SET needs a prefs object".into());
        };
        if obj.is_empty() {
            return Err("PREFS_SET changes nothing: the prefs object is empty".into());
        }
        let mut next = self.get(user).unwrap_or_default();
        for (k, v) in obj {
            let Some((_, allowed)) = FIELDS.iter().find(|(name, _)| name == k) else {
                return Err(format!("unknown setting {k:?}; the settings are {}", FIELDS.iter().map(|f| f.0).collect::<Vec<_>>().join(", ")));
            };
            let value = match v {
                Value::Null => None,
                Value::String(s) => {
                    let s = s.trim();
                    if !allowed.contains(&s) {
                        return Err(format!("{k}: {s:?} is not one of {}", allowed.join(", ")));
                    }
                    Some(s.to_string())
                }
                _ => return Err(format!("{k}: expected one of {}, or null to unset", allowed.join(", "))),
            };
            match k.as_str() {
                "menu" => next.menu = value,
                "theme" => next.theme = value,
                _ => next.opens_on = value,
            }
        }
        next.updated_at = now_ms();
        {
            let mut m = self.map.write();
            if next.is_empty() {
                m.remove(user);
            } else {
                if !m.contains_key(user) && m.len() >= MAX_USERS {
                    return Err(format!("the settings store holds {MAX_USERS} accounts already"));
                }
                m.insert(user.to_string(), next.clone());
            }
        }
        self.save()?;
        Ok(next)
    }

    fn save(&self) -> Result<(), String> {
        let Some(p) = &self.path else { return Ok(()) };
        let body = serde_json::to_vec_pretty(&*self.map.read()).map_err(|e| e.to_string())?;
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
            let mut f = o.open(&tmp).map_err(|e| format!("{FILE}.tmp: {e}"))?;
            f.write_all(&body).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, p).map_err(|e| format!("{FILE}: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Tmp {
            let p = std::env::temp_dir().join(format!("elasticpro-prefs-{tag}-{}", now_ms()));
            std::fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn unset_is_null_not_a_default() {
        let s = UserPrefs::open(None);
        assert!(s.get("ann").is_none());
        let p = s.set("ann", &json!({ "theme": "warm" })).unwrap();
        assert_eq!(p.public(), json!({ "menu": null, "theme": "warm", "opensOn": null }));
        assert!(p.updated_at > 0);
    }

    #[test]
    fn a_patch_merges_and_null_unsets() {
        let s = UserPrefs::open(None);
        s.set("ann", &json!({ "theme": "dark-blue", "menu": "left" })).unwrap();
        let p = s.set("ann", &json!({ "opensOn": "all" })).unwrap();
        assert_eq!(p.public(), json!({ "menu": "left", "theme": "dark-blue", "opensOn": "all" }));
        let p = s.set("ann", &json!({ "theme": null })).unwrap();
        assert_eq!(p.theme, None);
        assert_eq!(p.menu.as_deref(), Some("left"));
        // Unsetting everything forgets the account.
        s.set("ann", &json!({ "menu": null, "opensOn": null })).unwrap();
        assert!(s.get("ann").is_none());
    }

    #[test]
    fn a_bad_value_or_key_saves_nothing() {
        let s = UserPrefs::open(None);
        s.set("ann", &json!({ "theme": "warm" })).unwrap();
        let e = s.set("ann", &json!({ "menu": "left", "theme": "neon" })).unwrap_err();
        assert!(e.contains("neon") && e.contains("system, light, dark"), "{e}");
        assert_eq!(s.get("ann").unwrap().menu, None, "the valid half of a refused patch is not kept");
        assert!(s.set("ann", &json!({ "font": "mono" })).unwrap_err().contains("unknown setting"));
        assert!(s.set("ann", &json!({ "menu": 3 })).unwrap_err().contains("expected one of"));
        assert!(s.set("ann", &json!({})).unwrap_err().contains("empty"));
        assert!(s.set("ann", &json!("warm")).unwrap_err().contains("prefs object"));
        assert!(s.set("  ", &json!({ "theme": "warm" })).unwrap_err().contains("no account"));
    }

    #[test]
    fn accounts_are_separate_and_the_file_comes_back() {
        let t = Tmp::new("file");
        let path = t.0.join(FILE);
        {
            let s = UserPrefs::open(Some(path.clone()));
            s.set("ann", &json!({ "theme": "warm" })).unwrap();
            s.set("bob", &json!({ "menu": "left" })).unwrap();
            assert_eq!(s.get("ann").unwrap().menu, None);
            assert_eq!(s.get("bob").unwrap().theme, None);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let s = UserPrefs::open(Some(path));
        assert_eq!(s.get("ann").unwrap().theme.as_deref(), Some("warm"));
        assert_eq!(s.get("bob").unwrap().menu.as_deref(), Some("left"));
    }

    #[test]
    fn the_choices_are_the_lists() {
        let c = choices();
        assert_eq!(c["theme"], json!(THEMES));
        assert_eq!(c["menu"], json!(["top", "left"]));
        assert_eq!(c["opensOn"], json!(["last", "all"]));
    }
}
