//! How much memory this process may spend on what: one budget, decided once at start from
//! the container's memory limit, that every part of the core holding bodies sizes itself
//! against.
//!
//! 0.3.21 crash-looped under its 1 GiB limit with a cache "budget" of 256 MB that was never
//! compared with what the cache really held. The fix is in two halves: the fleet cache now
//! counts what it holds honestly (`fleet::entry::Body`), and the budget it counts against
//! comes from the one number that decides whether the process is killed — the cgroup's
//! limit — rather than from a constant that knew nothing about it.
//!
//! The split, for a limit L:
//!   cache       — L/4, or `ELASTICPRO_CACHE_MB` when it is set. Held bodies, all of them.
//!   in flight   — L/4: response bodies being received, parsed or sent at once.
//!   read cache  — L/16, at most 64 MiB: small, short-lived read-through copies.
//! The rest (at least 3/8 of L) is the process itself, the replies being serialised from
//! the cache, and slack for the allocator. No limit at all (the desktop app, a bare
//! binary): the 256 MiB cache that has always been the default, and the same for the rest.

use std::path::Path;
use std::sync::OnceLock;

const MIB: u64 = 1024 * 1024;
/// The cache's default without a limit to derive it from: the old shipped value.
pub const DEFAULT_CACHE_MB: u64 = 256;
pub const DEFAULT_INFLIGHT_MB: u64 = 256;
pub const READ_CACHE_MAX_MB: u64 = 64;
/// The smallest cache budget, however small the container: below this every on-demand
/// body is evicted the moment it arrives.
pub const MIN_CACHE_MB: u64 = 16;
/// What one byte of cache costs the process at its worst: the body held, plus a reply or a
/// disk/Redis write serialising it at the same time.
pub const CACHE_OVERHEAD: u64 = 2;
/// The process without any bodies: runtime, TLS, tunnels, the account and request stores.
pub const BASE_RESERVE_MB: u64 = 128;
/// Above this a "limit" is the kernel's way of saying none (cgroup v1 reports ~2^63).
const UNLIMITED_ABOVE: u64 = 1 << 50;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryBudget {
    /// The container's memory limit, when there is one.
    pub limit_bytes: Option<u64>,
    /// Where the limit was read: "cgroup v2", "cgroup v1", or "none".
    pub limit_source: &'static str,
    /// Every body the fleet cache holds, together.
    pub cache_bytes: usize,
    /// Whether `cache_bytes` is the operator's `ELASTICPRO_CACHE_MB` or derived.
    pub cache_from_env: bool,
    /// Response bodies in flight at once.
    pub inflight_bytes: usize,
    /// Small read-through copies.
    pub read_cache_bytes: usize,
    /// Set when the operator's cache size cannot fit the limit with its overhead.
    pub warning: Option<String>,
}

/// The container's limit from a cgroup filesystem rooted at `root` (normally
/// `/sys/fs/cgroup`): v2's `memory.max`, else v1's `memory/memory.limit_in_bytes`. "max",
/// an absurdly large number, an unreadable file or no file at all mean no limit.
pub fn read_cgroup_limit(root: &Path) -> Option<(u64, &'static str)> {
    let parse = |p: &Path| -> Option<u64> {
        let t = std::fs::read_to_string(p).ok()?;
        let t = t.trim();
        if t == "max" {
            return None;
        }
        t.parse::<u64>().ok().filter(|n| *n > 0 && *n < UNLIMITED_ABOVE)
    };
    let v2 = root.join("memory.max");
    if v2.exists() {
        return parse(&v2).map(|n| (n, "cgroup v2"));
    }
    parse(&root.join("memory/memory.limit_in_bytes")).map(|n| (n, "cgroup v1"))
}

/// The split for a limit and an operator's cache size. Pure, so every case is a test.
pub fn split(limit: Option<(u64, &'static str)>, cache_mb: Option<u64>) -> MemoryBudget {
    let lim = limit.map(|l| l.0);
    let derived_cache = match lim {
        Some(l) => (l / 4).max(MIN_CACHE_MB * MIB),
        None => DEFAULT_CACHE_MB * MIB,
    };
    let cache = cache_mb.map(|m| m.max(1) * MIB).unwrap_or(derived_cache);
    let inflight = lim.map(|l| l / 4).unwrap_or(DEFAULT_INFLIGHT_MB * MIB);
    let read_cache = lim.map(|l| (l / 16).min(READ_CACHE_MAX_MB * MIB)).unwrap_or(READ_CACHE_MAX_MB * MIB);
    let warning = match (lim, cache_mb) {
        (Some(l), Some(mb)) => {
            let need = cache * CACHE_OVERHEAD + inflight + read_cache + BASE_RESERVE_MB * MIB;
            (need > l).then(|| format!(
                "ELASTICPRO_CACHE_MB={mb} does not fit the container's {} MiB limit: a cached body can cost twice its size while it is \
                 being served, and with the in-flight share ({} MiB) and the process itself that needs about {} MiB — the core will be \
                 OOM-killed under load. Lower CACHE_MB to {} or less, or leave it empty to size it from the limit, or raise CORE_MEM_LIMIT",
                l / MIB, inflight / MIB, need / MIB,
                (l.saturating_sub(inflight + read_cache + BASE_RESERVE_MB * MIB) / CACHE_OVERHEAD / MIB).max(1),
            ))
        }
        _ => None,
    };
    MemoryBudget {
        limit_bytes: lim,
        limit_source: limit.map(|l| l.1).unwrap_or("none"),
        cache_bytes: cache as usize,
        cache_from_env: cache_mb.is_some(),
        inflight_bytes: inflight as usize,
        read_cache_bytes: read_cache as usize,
        warning,
    }
}

fn env_mb(name: &str) -> Option<u64> {
    std::env::var(name).ok().and_then(|v| v.trim().parse().ok())
}

/// This process's budget, decided the first time it is asked for. `config.txt` has been
/// applied to the environment by then (`settings::init` runs before anything else).
pub fn budget() -> &'static MemoryBudget {
    static B: OnceLock<MemoryBudget> = OnceLock::new();
    B.get_or_init(|| split(read_cgroup_limit(Path::new("/sys/fs/cgroup")), env_mb("ELASTICPRO_CACHE_MB")))
}

/// The one line at start that says what the core will hold, and the warning if the
/// operator's cache size cannot fit.
pub fn log_budget() {
    let b = budget();
    tracing::info!(
        limit_mib = b.limit_bytes.map(|l| l / MIB),
        limit_source = b.limit_source,
        cache_mib = b.cache_bytes as u64 / MIB,
        cache_from = if b.cache_from_env { "ELASTICPRO_CACHE_MB" } else if b.limit_bytes.is_some() { "a quarter of the limit" } else { "default" },
        inflight_mib = b.inflight_bytes as u64 / MIB,
        read_cache_mib = b.read_cache_bytes as u64 / MIB,
        "memory budget"
    );
    if let Some(w) = &b.warning {
        tracing::warn!("{w}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: u64 = 1024 * MIB;

    #[test]
    fn the_split_follows_the_limit() {
        let b = split(Some((G, "cgroup v2")), None);
        assert_eq!((b.cache_bytes as u64, b.inflight_bytes as u64, b.read_cache_bytes as u64), (256 * MIB, 256 * MIB, 64 * MIB));
        assert!(b.warning.is_none() && !b.cache_from_env);
        let b = split(Some((2 * G, "cgroup v2")), None);
        assert_eq!((b.cache_bytes as u64, b.inflight_bytes as u64, b.read_cache_bytes as u64), (512 * MIB, 512 * MIB, 64 * MIB));
        let b = split(Some((5 * G, "cgroup v1")), None);
        assert_eq!((b.cache_bytes as u64, b.inflight_bytes as u64, b.read_cache_bytes as u64), (1280 * MIB, 1280 * MIB, 64 * MIB));
        assert_eq!(b.limit_source, "cgroup v1");
        // A small container: the read cache shrinks with it, the cache has a floor.
        let b = split(Some((256 * MIB, "cgroup v2")), None);
        assert_eq!((b.cache_bytes as u64, b.read_cache_bytes as u64), (64 * MIB, 16 * MIB));
        let b = split(Some((32 * MIB, "cgroup v2")), None);
        assert_eq!(b.cache_bytes as u64, MIN_CACHE_MB * MIB);
    }

    #[test]
    fn no_limit_keeps_the_old_defaults() {
        let b = split(None, None);
        assert_eq!(b.limit_bytes, None);
        assert_eq!(b.limit_source, "none");
        assert_eq!((b.cache_bytes as u64, b.inflight_bytes as u64, b.read_cache_bytes as u64), (256 * MIB, 256 * MIB, 64 * MIB));
        assert!(b.warning.is_none());
        let b = split(None, Some(4096));
        assert_eq!(b.cache_bytes as u64, 4096 * MIB);
        assert!(b.warning.is_none(), "no limit, nothing to warn against");
    }

    #[test]
    fn cache_mb_wins_and_is_warned_about_when_it_cannot_fit() {
        let b = split(Some((2 * G, "cgroup v2")), Some(256));
        assert_eq!(b.cache_bytes as u64, 256 * MIB);
        assert!(b.cache_from_env && b.warning.is_none());
        // 0.3.21's shipped pair: CACHE_MB=256 in 1 GiB. 2×256 + 256 + 64 + 128 = 960: fits.
        assert!(split(Some((G, "cgroup v2")), Some(256)).warning.is_none());
        // 400 MiB in 1 GiB does not: 800 + 256 + 64 + 128 > 1024.
        let w = split(Some((G, "cgroup v2")), Some(400)).warning.expect("warned");
        assert!(w.contains("ELASTICPRO_CACHE_MB=400") && w.contains("1024 MiB"), "{w}");
        assert!(w.contains("288 or less"), "names what would fit: {w}");
    }

    #[test]
    fn cgroup_limits_are_read_from_v2_then_v1_and_none_means_none() {
        let dir = std::env::temp_dir().join(format!("ep-cgroup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("memory")).unwrap();
        assert_eq!(read_cgroup_limit(&dir), None, "no files: no limit");
        std::fs::write(dir.join("memory/memory.limit_in_bytes"), "1073741824\n").unwrap();
        assert_eq!(read_cgroup_limit(&dir), Some((G, "cgroup v1")));
        std::fs::write(dir.join("memory/memory.limit_in_bytes"), "9223372036854771712\n").unwrap();
        assert_eq!(read_cgroup_limit(&dir), None, "v1's way of saying unlimited");
        std::fs::write(dir.join("memory.max"), "2147483648\n").unwrap();
        assert_eq!(read_cgroup_limit(&dir), Some((2 * G, "cgroup v2")), "v2 first");
        std::fs::write(dir.join("memory.max"), "max\n").unwrap();
        assert_eq!(read_cgroup_limit(&dir), None, "v2 unlimited, and v1 is not consulted on a v2 host");
        std::fs::write(dir.join("memory.max"), "garbage").unwrap();
        assert_eq!(read_cgroup_limit(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
