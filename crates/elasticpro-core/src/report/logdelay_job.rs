//! The log delay report's job (docs/LOGDELAY.md "Report kind log_delay"): built from the
//! built-in store alone — no cluster is asked, so it builds under the emergency stop too —
//! then kept and mailed like the other kinds, with the workbook and the CSV attached and an
//! HTML body beside the plain text.

use super::jobs::{FileRef, Job, Kind, Status};
use super::run::{now_ms, JobEnd};
use super::xlsx;
use crate::bridge::Core;
use crate::logdelay::report::{self as ldreport, Options};
use crate::logdelay::summary::Range;
use crate::logdelay::{time, Settings};
use serde_json::{json, Value};
use std::sync::Arc;

impl Core {
    /// Every extra column any cluster is measured with: what the options may group by or show.
    pub(crate) fn logdelay_extras_union(&self, s: &Settings) -> Vec<String> {
        let mut out: Vec<String> = s.extras_for("");
        for id in self.all_specs().into_iter().map(|c| c.id) {
            for e in s.extras_for(&id) {
                if !out.contains(&e) {
                    out.push(e);
                }
            }
        }
        out
    }

    pub(super) async fn report_logdelay_job(self: &Arc<Self>, job: &Job) -> JobEnd {
        if self.logdelay_store().is_none() {
            return JobEnd::failed("no data directory");
        }
        let now = now_ms();
        let s = self.logdelay_settings();
        let extras = self.logdelay_extras_union(&s);
        let options = Options::default().apply(job.options.as_ref().unwrap_or(&Value::Null), &extras).unwrap_or_default();
        let (Some(from), Some(to)) = (time::parse_day(&job.period.from), time::parse_day(&job.period.to)) else {
            return JobEnd::failed("the period is not two YYYY-MM-DD days");
        };
        // An hourly report (its schedule's period, or "lastHour") covers that hour alone: the
        // device rows, periods and late time are measured over it; the day's figures are its day's.
        let range = match job.period.hour {
            Some(h) => Range { from, to, from_ms: h, to_ms: h + crate::report::period::HOUR_MS },
            None => Range::days(from, to),
        };
        let every = self.delay_sink_config().every_hours.clamp(1, 24);
        self.report_progress(&job.id, 0, 2);
        let inputs = self.logdelay_inputs_for(&job.cluster_ids).await;
        let ids: Vec<String> = inputs.iter().map(|c| c.id.clone()).collect();
        let findings = self.logdelay_findings(&ids, &range, now, every);
        let app_url = self.public_url();
        let i = ldreport::Inputs { clusters: &inputs, range: &range, now, every_hours: every, findings: &findings, options: &options, extras: &extras,
                                   app_url: app_url.as_deref() };
        let built = match ldreport::build(&i) {
            Ok(b) => b,
            Err(e) => return JobEnd::failed(format!("the file could not be built: {e}")),
        };
        self.report_progress(&job.id, 1, 2);
        let stem = match job.period.hour {
            Some(h) => format!("elasticpro-log-delay-{}", time::local_datetime(h).format("%Y-%m-%dT%H00")),
            None => format!("elasticpro-log-delay-{}_{}", job.period.from, job.period.to),
        };
        let mut files: Vec<(String, String, Vec<u8>)> = vec![];
        let mut kept: Option<FileRef> = None;
        if let Some(x) = built.xlsx {
            let name = format!("{stem}.xlsx");
            match self.report_store_file(&job.id, &name, x.clone()).await {
                Ok(f) => kept = Some(f),
                Err(e) => return JobEnd::failed(format!("the file could not be kept: {e}")),
            }
            files.push((name, xlsx::MIME.to_string(), x));
        }
        if let Some(c) = built.csv {
            let name = format!("{stem}-devices.csv");
            match self.report_store_file(&job.id, &name, c.clone()).await {
                Ok(f) => { if kept.is_none() { kept = Some(f) } }
                Err(e) => return JobEnd::failed(format!("the file could not be kept: {e}")),
            }
            files.push((name, "text/csv".to_string(), c));
        }
        let Some(file) = kept else { return JobEnd::failed("the options asked for no attachment at all (xlsx and csv both off)") };
        let mut end = JobEnd::done(file, options.pdf.then(|| "a PDF was asked for: not built, this build has no PDF writer".to_string()));
        if !(job.mail || job.kind == Kind::Mailed) {
            return end;
        }
        if let Some(by) = self.report_stop_asked(&job.id) {
            end.status = Status::Stopped;
            end.stopped_by = Some(by);
            return end;
        }
        self.job_state(&job.id, "mailing");
        let (sched, _) = self.report_schedule_effective(job.report);
        if job.kind == Kind::Mailed {
            self.report_mail_started(&job.id).await;
        }
        let subject = format!("{} · {}", sched.subject_for(&job.period), built.headline);
        let sent = self.report_mail_parts(job.report, &job.by, &subject, &built.text, Some(&built.html), files).await;
        end.recipients = *sent.as_ref().unwrap_or(&sched.recipients());
        end.mail_error = sent.err();
        tracing::info!(job = %job.id, figures = %json!(built.figures), "log delay report built");
        end
    }

    /// The server's public address for the mail's link, when config knows it.
    fn public_url(&self) -> Option<String> {
        crate::settings::get().text("UI_PUBLIC_URL").map(|u| u.trim_end_matches('/').to_string()).filter(|u| !u.is_empty())
            .map(|u| format!("{u}/#/reports/log-delay"))
    }
}
