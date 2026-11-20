//! The run's own log lines and parts, gathered in this process while it runs (docs/JOBS.md
//! "Run details"). Nothing reads a container's log: the lines the core and the worker already
//! write are caught as they are written.
//!
//! * `open` / `take` — a run's `detail::Collecting`, keyed by its run id: opened when the run
//!   begins, taken when its last part ends (and written into its detail then).
//! * `Layer` — a `tracing` layer the binary installs beside its JSON log. Every event written
//!   inside a span that carries `run = <id>` (the governor's lane wraps every job's work in
//!   one, `Core::governed`), or with a `run` field of its own, is added to that run's lines —
//!   only while the run is open, so a line about a run that ended is not held.
//!
//! Lines a run adds itself (`add_line`) go straight in and are marked `captured`, so the layer
//! does not add them twice.

use super::detail::{Collecting, Line, Part};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::LazyLock;
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;

static OPEN: LazyLock<parking_lot::Mutex<HashMap<String, Collecting>>> = LazyLock::new(Default::default);
/// How many runs are open: an event outside every run costs one load when none is.
static COUNT: AtomicUsize = AtomicUsize::new(0);

/// The field a run's span (or a line) names its run by.
pub const RUN_FIELD: &str = "run";
/// The field a line written by `add_line` carries, so the layer leaves it.
pub const CAPTURED_FIELD: &str = "captured";

/// Begin gathering for `run_id`.
pub fn open(run_id: &str) {
    let mut m = OPEN.lock();
    if m.insert(run_id.to_string(), Collecting::default()).is_none() {
        COUNT.fetch_add(1, Ordering::Relaxed);
    }
}

/// Stop gathering for `run_id` and hand over what was gathered.
pub fn take(run_id: &str) -> Option<Collecting> {
    let mut m = OPEN.lock();
    let c = m.remove(run_id);
    if c.is_some() {
        COUNT.fetch_sub(1, Ordering::Relaxed);
    }
    c
}

/// Whether `run_id` is being gathered.
pub fn is_open(run_id: &str) -> bool {
    COUNT.load(Ordering::Relaxed) > 0 && OPEN.lock().contains_key(run_id)
}

fn with(run_id: &str, f: impl FnOnce(&mut Collecting)) {
    if COUNT.load(Ordering::Relaxed) == 0 {
        return;
    }
    if let Some(c) = OPEN.lock().get_mut(run_id) {
        f(c);
    }
}

/// A part of an open run.
pub fn add_part(run_id: &str, p: Part) {
    with(run_id, |c| c.part(p));
}

/// A line of an open run.
pub fn add_line(run_id: &str, l: Line) {
    with(run_id, |c| c.line(l));
}

/// The window an open run reads.
pub fn set_window(run_id: &str, from: i64, to: i64) {
    with(run_id, |c| c.window(from, to));
}

/// The run id a span names, kept on the span.
struct RunTag(String);

#[derive(Default)]
struct Fields {
    run: Option<String>,
    cluster: Option<String>,
    message: Option<String>,
    captured: bool,
    rest: Vec<(String, String)>,
}

impl Fields {
    fn put(&mut self, name: &str, v: String) {
        match name {
            RUN_FIELD => self.run = Some(v),
            CAPTURED_FIELD => self.captured = true,
            "cluster" | "cluster_id" | "clusterId" => {
                self.cluster.get_or_insert_with(|| v.clone());
                self.rest.push((name.to_string(), v));
            }
            "message" => self.message = Some(v),
            _ => self.rest.push((name.to_string(), v)),
        }
    }
}

impl Visit for Fields {
    fn record_str(&mut self, f: &Field, v: &str) {
        self.put(f.name(), v.to_string());
    }
    fn record_debug(&mut self, f: &Field, v: &dyn std::fmt::Debug) {
        self.put(f.name(), format!("{v:?}"));
    }
}

/// The text of a line: the message, then its fields as `k=v`.
fn text_of(f: &Fields) -> String {
    let mut s = f.message.clone().unwrap_or_default();
    for (k, v) in &f.rest {
        if !s.is_empty() {
            s.push(' ');
        }
        s.push_str(k);
        s.push('=');
        s.push_str(v);
    }
    s
}

/// The `tracing` layer that adds what a run writes to its lines. Installed by the binary.
#[derive(Clone, Copy, Debug, Default)]
pub struct Layer;

impl<S> tracing_subscriber::Layer<S> for Layer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        if attrs.metadata().fields().field(RUN_FIELD).is_none() {
            return;
        }
        let mut f = Fields::default();
        attrs.record(&mut f);
        if let (Some(run), Some(span)) = (f.run, ctx.span(id)) {
            span.extensions_mut().insert(RunTag(run));
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        if COUNT.load(Ordering::Relaxed) == 0 {
            return;
        }
        let mut f = Fields::default();
        event.record(&mut f);
        if f.captured {
            return;
        }
        let run = f.run.clone().or_else(|| {
            // The innermost span that names a run (the scope goes from the event's span outwards).
            ctx.event_scope(event).and_then(|mut scope| scope.find_map(|s| {
                let ext = s.extensions();
                ext.get::<RunTag>().map(|t| t.0.clone())
            }))
        });
        let Some(run) = run else { return };
        let level = event.metadata().level().as_str().to_string();
        let line = Line { at: crate::fleet::now_ms(), level, cluster: f.cluster.clone(), run: false, text: text_of(&f) };
        add_line(&run, line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::layer::SubscriberExt;

    #[test]
    fn lines_written_inside_a_runs_span_are_its_own_and_only_while_it_is_open() {
        let sub = tracing_subscriber::registry().with(Layer);
        let id = format!("cap-{}", crate::auth::random_hex(6));
        let other = format!("cap-{}", crate::auth::random_hex(6));
        tracing::subscriber::with_default(sub, || {
            tracing::info!(run = %id, "before it opened");
            open(&id);
            open(&other);
            let span = tracing::info_span!("job_run", run = %id);
            span.in_scope(|| {
                tracing::warn!(cluster = "aib", failed = 2, "shards failed");
                tracing::info!("page read");
            });
            tracing::info!("outside every run");
            tracing::error!(run = %other, cluster = "c9", "the other run's line");
            add_line(&id, Line { at: 1, level: "INFO".into(), cluster: None, run: true, text: "run.end".into() });
            tracing::info!(run = %id, captured = true, "run.end");
        });
        let mine = take(&id).expect("open").finish();
        let texts: Vec<&str> = mine.lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, vec!["shards failed cluster=aib failed=2", "page read", "run.end"]);
        assert_eq!(mine.lines[0].cluster.as_deref(), Some("aib"));
        assert_eq!(mine.lines[0].level, "WARN");
        let theirs = take(&other).expect("open").finish();
        assert_eq!(theirs.lines.len(), 1);
        assert_eq!(theirs.lines[0].level, "ERROR");
        assert!(take(&id).is_none(), "taken once");
        // After it ended: nothing is held for it.
        add_part(&id, Part::ok("x", None, None));
        assert!(!is_open(&id));
    }
}
