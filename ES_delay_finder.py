#!/usr/bin/env python3
"""
Elasticsearch Log Delay Finder (v2)

Config format (config.yml)
--------------------------
elasticsearch:
  hosts:
    ES-stage: "https://172.11.1.1:9200"
    ESprod:   "https://172.1.1.1:9200"
  username: "admin"
  password: ""
  index_pattern: "logstash-*"
  request_timeout: 300
  connect_timeout: 10
  max_retries: 3
  retry_delay: 5

primary_agg_field: "src_hostname"    # device bucket field
client_id_field: "ClientID"
branch_field: "branch"

# Metadata fields extracted per bucket via top_hits.
# Columns in the XLSX and the realtime view are built DYNAMICALLY
# from this list. To add "zone": just append - "zone" here.
metadata_fields:
  - "parser_tag"
  - "fwdtag"
  - "src_ip"
  - "tag1"
  - "ClientID"
  - "branch"
  - "log_type"

output:
  directory: "/var/lib/es-delay-finder/output/"
  # Column order for the "Latest Status" sheet. Omit to keep the default.
  # "*metadata" expands to every metadata_fields entry not listed above it.
  latest_status_columns:
    - device
    - log_type
    - zone
    - tag1
    - delay_minutes
    - status
    - pattern
    - reason
    - fix
    - "*metadata"
    - es_name

output_elasticsearch:            # forward collected delay data (optional)
  enabled: false
  url: "https://203.0.113.21:9200"
  username: "admin"              # or OUTPUT_ES_USER env var
  password: ""                   # or OUTPUT_ES_PASS env var
  index_prefix: "volume-report"  # creates: volume-report-2026.08
  verify_certs: false
  pipeline: ""

email:
  enabled: true
  smtp_host: "smtp.office365.com"
  smtp_port: 587
  tls: "starttls"
  smtp_user: "health-system@example.com"
  smtp_pass: "pass"              # or SMTP_PASS env var
  from: "health-system@example.com"
  to:
    - "user@example.com"
  subject_prefix: "Elasticsearch Log Delay Report"

Optional extras (all have sane defaults):
  arrival_time_field: "@timestamp"
  event_time_field: ["ingested_time", "event_created", "event.created"]
  query:
    timezone: "Asia/Kolkata"
    delay_threshold_minutes: 30
    critical_threshold_minutes: 60
    page_size: 1000
    default_time: "live"
  output:
    retention_days: 30
    filename_prefix: "log_delay"

Usage
-----
Report mode (all ES hosts -> ONE XLSX -> email):
    es-delay-finder.py --config config.yml
    es-delay-finder.py --config config.yml --time yesterday
    es-delay-finder.py --config config.yml --time "last 5 days" --no-email

Realtime single-device terminal view:
    es-delay-finder.py --single --config config.yml
    es-delay-finder.py --single --config config.yml \
        --url "https://172.1.1.1:9200" --device 10.20.30.40 --logtype all
    ...add --watch 30 for auto-refresh.
"""

from __future__ import annotations

import argparse
import getpass
import html
import ipaddress
import logging
import os
import re
import shutil
import smtplib
import ssl
import sys
import time as time_module
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from statistics import mean, median
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlparse

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML missing. Run: python3 -m pip install PyYAML",
          file=sys.stderr)
    raise SystemExit(2)

try:
    from elasticsearch import Elasticsearch, helpers
    from elasticsearch.exceptions import ApiError
    from elastic_transport import ConnectionError as ESConnectionError
except ImportError:
    print("ERROR: Elasticsearch client missing. "
          "Run: python3 -m pip install elasticsearch", file=sys.stderr)
    raise SystemExit(2)

try:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.worksheet import Worksheet
except ImportError:
    print("ERROR: openpyxl missing. Run: python3 -m pip install openpyxl",
          file=sys.stderr)
    raise SystemExit(2)

try:
    from zoneinfo import ZoneInfo
except ImportError:
    print("ERROR: Python 3.9 or newer is required.", file=sys.stderr)
    raise SystemExit(2)


LOGGER = logging.getLogger("es_delay_finder")

DEFAULT_ARRIVAL_FIELDS = ["@timestamp"]
DEFAULT_EVENT_FIELDS = ["ingested_time", "event_created", "event.created"]
DEFAULT_METADATA_FIELDS = [
    "parser_tag", "fwdtag", "fwd_tag", "src_ip", "tag1", "zone",
    "ClientID", "ClientName", "branch", "logtag", "log_type",
    "observer_hostname",
]
IP_LIKE_FIELDS = {"src_ip", "source.ip", "destination.ip", "host.ip"}
LOGTYPE_FIELD_NAMES = {"log_type", "logtype", "logtag"}

STATUS_ORDER = ["CRITICAL", "DELAYED", "CLOCK_AHEAD", "ERROR", "OK"]

# ---------------------------------------------------------------------------
# Root cause knowledge base: status -> (likely reasons, remediation steps)
# ---------------------------------------------------------------------------
DIAGNOSIS: Dict[str, Tuple[List[str], List[str]]] = {
    "CRITICAL": (
        [
            "Forwarder/agent down or restarting, now draining a large queue",
            "Logstash pipeline backpressure (persistent queue filling up)",
            "Elasticsearch indexing pressure (bulk rejections, hot node)",
            "WAN/VPN link saturated or flapping between branch and SIEM",
            "Device clock running BEHIND real time (NTP broken on source)",
        ],
        [
            "1. Check forwarder service status and its local spool/queue size",
            "2. Check Logstash: queue size, pipeline events in/out rate,"
            " and dead letter queue",
            "3. Check ES: GET _cat/thread_pool/write?v for rejections;"
            " check disk watermark and hot node CPU",
            "4. Verify network path (MTR/ping) from forwarder to SIEM",
            "5. Verify NTP sync on the source device (chronyc/ntpq)",
        ],
    ),
    "DELAYED": (
        [
            "Forwarder batching/flush interval set too high",
            "Intermittent network latency between site and SIEM",
            "Logstash worker/batch settings undersized for the load",
            "Periodic burst traffic (backup jobs, scans) queuing logs",
        ],
        [
            "1. Lower the forwarder flush/batch interval (e.g. 30s -> 5s)",
            "2. Compare delay across devices on the same site - if all are"
            " delayed, suspect the site forwarder or link, not the device",
            "3. Tune Logstash pipeline.workers / pipeline.batch.size",
            "4. Trend the delay: if it grows during business hours only,"
            " size the link/forwarder for peak load",
        ],
    ),
    "CLOCK_AHEAD": (
        [
            "Source device clock is AHEAD of real time (broken/missing NTP)",
            "Wrong timezone on the device stamping local time as UTC",
            "Parser writing local time into a UTC field",
        ],
        [
            "1. Fix NTP on the source device and confirm sync",
            "2. Verify the device timezone and the parser's date filter"
            " timezone setting",
            "3. Re-check after one polling cycle - negative delay should"
            " return to ~0",
        ],
    ),
    "ERROR": (
        [
            "Event timestamp field missing or unparseable",
            "Parser/grok failure - fields not extracted for this log type",
            "Mapping change: field renamed or moved in a new index",
        ],
        [
            "1. Inspect a raw sample document for this device in Kibana",
            "2. Fix the parser/grok pattern or the date filter",
            "3. Update event_time_field in config.yml if field names changed",
        ],
    ),
    "OK": (
        ["Logs are arriving within the configured threshold."],
        ["No action needed. Keep monitoring."],
    ),
    "NO_DATA": (
        [
            "No logs received from this device in the selected window",
            "Device decommissioned, forwarder stopped, or filter dropping"
            " its logs",
        ],
        [
            "1. Confirm the device is alive and still expected to log",
            "2. Check the forwarder input/filter for this device",
            "3. Search a wider time range to find the last seen event",
        ],
    ),
}


def short_reason(status: str, trend: str = "") -> str:
    base = {
        "OK": "Healthy - within threshold",
        "DELAYED": "Pipeline lag: forwarder batching / network latency",
        "CRITICAL": "Severe lag: forwarder backlog / pipeline backpressure"
                    " / device clock behind",
        "CLOCK_AHEAD": "Device clock ahead of real time (NTP issue)",
        "ERROR": "Timestamp missing or unparseable (parser issue)",
        "NO_DATA": "No logs received in window",
    }.get(status, status)
    if trend == "WORSENING" and status in {"DELAYED", "CRITICAL"}:
        base += " - backlog is GROWING, act now"
    elif trend == "IMPROVING" and status in {"DELAYED", "CRITICAL"}:
        base += " - queue is draining (improving)"
    return base


def short_fix(status: str) -> str:
    return {
        "OK": "None",
        "DELAYED": "Reduce forwarder flush interval; check site link;"
                   " tune Logstash batch/workers",
        "CRITICAL": "Check forwarder queue & service; Logstash backpressure;"
                    " ES write rejections; NTP on device",
        "CLOCK_AHEAD": "Fix NTP/timezone on source device and parser date"
                       " filter",
        "ERROR": "Fix parser/grok or update event_time_field in config.yml",
        "NO_DATA": "Verify device/forwarder is alive and shipping",
    }.get(status, "")


# ---------------------------------------------------------------------------
# Config / dataclasses
# ---------------------------------------------------------------------------
@dataclass
class Settings:
    """Global settings shared by all targets, parsed from config.yml."""
    primary_agg_field: str
    client_id_field: str
    branch_field: str
    metadata_fields: List[str]
    arrival_fields: List[str]
    event_fields: List[str]
    timezone: str
    delay_threshold_minutes: float
    critical_threshold_minutes: float
    page_size: int
    tz_tolerance_minutes: float
    very_long_delay_minutes: float
    uneven_spread_minutes: float


@dataclass
class ESTarget:
    name: str
    url: str
    username: Optional[str]
    password: Optional[str]
    api_key: Optional[str]
    index_pattern: str
    verify_ssl: bool
    ca_cert: Optional[str]
    request_timeout: int
    connect_timeout: int
    max_retries: int
    retry_delay: int


@dataclass
class DelayRecord:
    es_name: str
    es_url: str
    index: str
    device: str
    report_date: str
    arrival_time: str
    event_time: str
    delay_minutes: Optional[float]
    delay_status: str
    log_type: str = ""
    metadata: Dict[str, str] = field(default_factory=dict)
    error: str = ""
    trend: str = "NO_TREND"
    pattern: str = "-"
    reason: str = ""
    fix: str = ""

    def meta(self, name: str) -> str:
        return self.metadata.get(name, "")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Elasticsearch log delay finder: consolidated XLSX "
                    "report for all ES URLs, or realtime single-device view.",
    )
    parser.add_argument("--config", help="Path to YAML configuration file.")
    parser.add_argument(
        "--time", dest="time_selection",
        help='live, today, yesterday, "last 5 days", or YYYY-MM-DD.',
    )
    parser.add_argument("--no-email", action="store_true",
                        help="Create reports but do not send email.")
    parser.add_argument("--email-only-on-delay", action="store_true",
                        help="Send email only when problems exist.")
    parser.add_argument("--log-level",
                        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
                        help="Override YAML logging level.")

    single = parser.add_argument_group("realtime single-device mode")
    single.add_argument("--single", action="store_true",
                        help="Realtime terminal view for one device.")
    single.add_argument("--url", help="Elasticsearch URL for --single.")
    single.add_argument("--username", help="ES username for --single.")
    single.add_argument("--password", help="ES password for --single "
                                           "(prompted securely if omitted).")
    single.add_argument("--device",
                        help="Device src_ip or hostname for --single.")
    single.add_argument("--logtype", default=None,
                        help='"all" or a specific log_type value.')
    single.add_argument("--index", help="Index pattern override for --single.")
    single.add_argument("--events", type=int, default=15,
                        help="Number of recent events to show (default 15).")
    single.add_argument("--watch", type=int, metavar="SECONDS",
                        help="Auto-refresh the realtime view every N seconds.")
    return parser.parse_args()


def read_yaml(path: Path) -> Dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"Configuration file not found: {path}")
    with path.open("r", encoding="utf-8") as handle:
        config = yaml.safe_load(handle) or {}
    if not isinstance(config, dict):
        raise ValueError("Top-level YAML configuration must be a mapping.")
    return config


def normalize_url(value: str) -> str:
    value = str(value).strip()
    if not value:
        raise ValueError("Elasticsearch URL cannot be empty.")
    if not re.match(r"^https?://", value, flags=re.IGNORECASE):
        host_port = value.rsplit(":", 1)
        if len(host_port) != 2 or not host_port[1].isdigit():
            raise ValueError(f"Invalid Elasticsearch URL: {value}")
        scheme = "https" if host_port[1] == "9200" else "http"
        value = f"{scheme}://{value}"
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"Unsupported scheme: {parsed.scheme}")
    if not parsed.hostname:
        raise ValueError(f"Missing hostname in URL: {value}")
    return value.rstrip("/")


def string_list(value: Any, default: Sequence[str]) -> List[str]:
    if value is None:
        return list(default)
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    raise ValueError(f"Expected string or list of strings, got: {value!r}")


def get_nested(mapping: Mapping[str, Any], path: str,
               default: Any = None) -> Any:
    current: Any = mapping
    for component in path.split("."):
        if not isinstance(current, Mapping) or component not in current:
            return default
        current = current[component]
    return current


def parse_settings(config: Mapping[str, Any]) -> Settings:
    query_config = config.get("query", {})
    if not isinstance(query_config, Mapping):
        query_config = {}

    primary = str(config.get("primary_agg_field", "src_hostname"))
    client_id_field = str(config.get("client_id_field", "ClientID"))
    branch_field = str(config.get("branch_field", "branch"))

    metadata = string_list(config.get("metadata_fields"),
                           DEFAULT_METADATA_FIELDS)
    # Guarantee the highlighted fields are always fetched.
    # Note: zone and tag1 are ALWAYS included in every report.
    for must_have in (client_id_field, branch_field, "src_ip", "tag1",
                      "zone"):
        if must_have and must_have not in metadata:
            metadata.append(must_have)

    warning = float(query_config.get(
        "delay_threshold_minutes",
        config.get("delay_threshold_minutes", 30)))
    critical = float(query_config.get(
        "critical_threshold_minutes",
        config.get("critical_threshold_minutes", 60)))

    return Settings(
        primary_agg_field=primary,
        client_id_field=client_id_field,
        branch_field=branch_field,
        metadata_fields=metadata,
        arrival_fields=string_list(config.get("arrival_time_field"),
                                   DEFAULT_ARRIVAL_FIELDS),
        event_fields=string_list(config.get("event_time_field"),
                                 DEFAULT_EVENT_FIELDS),
        timezone=str(query_config.get(
            "timezone", config.get("timezone", "Asia/Kolkata"))),
        delay_threshold_minutes=warning,
        critical_threshold_minutes=critical,
        page_size=int(query_config.get(
            "page_size", config.get("page_size", 1000))),
        tz_tolerance_minutes=float(query_config.get(
            "tz_offset_tolerance_minutes", 3)),
        very_long_delay_minutes=float(query_config.get(
            "very_long_delay_minutes", 2000)),
        uneven_spread_minutes=float(query_config.get(
            "uneven_spread_minutes", max(60.0, 2 * warning))),
    )


def parse_targets(config: Mapping[str, Any]) -> List[ESTarget]:
    es_config = config.get("elasticsearch")
    if not isinstance(es_config, Mapping):
        raise ValueError("Missing 'elasticsearch' section in YAML.")
    hosts = es_config.get("hosts")
    if not isinstance(hosts, Mapping) or not hosts:
        raise ValueError("'elasticsearch.hosts' must contain at least"
                         " one host.")

    g_user = es_config.get("username") or os.getenv("ES_USER")
    g_pass = (es_config.get("password") or es_config.get("pass")
              or os.getenv("ES_PASS"))
    g_api = es_config.get("api_key")

    request_timeout = int(es_config.get("request_timeout", 300))
    connect_timeout = int(es_config.get("connect_timeout", 10))
    max_retries = int(es_config.get("max_retries", 3))
    retry_delay = int(es_config.get("retry_delay", 5))
    global_index = str(es_config.get(
        "index_pattern", config.get("index_pattern", "logstash-*")))
    g_verify = bool(es_config.get("verify_ssl",
                                  es_config.get("verify_certs", False)))
    g_ca = es_config.get("ca_cert")

    targets: List[ESTarget] = []
    for name, definition in hosts.items():
        if isinstance(definition, str):
            settings: Dict[str, Any] = {"url": definition}
        elif isinstance(definition, Mapping):
            settings = dict(definition)
        else:
            raise ValueError(f"Host '{name}' must be a URL string or"
                             " a mapping.")
        targets.append(ESTarget(
            name=str(name),
            url=normalize_url(settings.get("url") or settings.get("host")
                              or settings.get("endpoint")),
            username=settings.get("username", g_user),
            password=(settings.get("password") or settings.get("pass")
                      or g_pass),
            api_key=settings.get("api_key", g_api),
            index_pattern=str(settings.get("index_pattern", global_index)),
            verify_ssl=bool(settings.get(
                "verify_ssl", settings.get("verify_certs", g_verify))),
            ca_cert=settings.get("ca_cert", g_ca),
            request_timeout=int(settings.get("request_timeout",
                                             request_timeout)),
            connect_timeout=int(settings.get("connect_timeout",
                                             connect_timeout)),
            max_retries=int(settings.get("max_retries", max_retries)),
            retry_delay=int(settings.get("retry_delay", retry_delay)),
        ))
    return targets


def configure_logging(config: Mapping[str, Any],
                      cli_level: Optional[str]) -> None:
    log_config = config.get("logging", {})
    if not isinstance(log_config, Mapping):
        log_config = {}
    level_name = cli_level or str(log_config.get("level", "INFO")).upper()
    level = getattr(logging, level_name, logging.INFO)
    handlers: List[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    logfile = log_config.get("logfile")
    if logfile:
        log_path = Path(str(logfile))
        log_path.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(log_path, encoding="utf-8"))
    logging.basicConfig(level=level,
                        format="%(asctime)s %(levelname)s %(message)s",
                        handlers=handlers, force=True)


def determine_time_selection(config: Mapping[str, Any],
                             cli_selection: Optional[str]) -> str:
    if cli_selection:
        return cli_selection
    query_config = config.get("query", {})
    if isinstance(query_config, Mapping) and (
            "default_time" in query_config or "time" in query_config):
        return str(query_config.get("default_time",
                                    query_config.get("time", "live")))
    return str(config.get("time", "live"))


def resolve_time_range(selection: str, timezone_name: str,
                       ) -> Tuple[datetime, datetime, List[date]]:
    tz = ZoneInfo(timezone_name)
    now = datetime.now(tz)
    normalized = str(selection).strip().lower()

    if normalized in {"live", "today"}:
        day = now.date()
        return datetime.combine(day, time.min, tzinfo=tz), now, [day]
    if normalized == "yesterday":
        day = now.date() - timedelta(days=1)
        start = datetime.combine(day, time.min, tzinfo=tz)
        return start, start + timedelta(days=1), [day]
    match = re.fullmatch(r"last\s+(\d+)\s+days?", normalized)
    if match:
        count = int(match.group(1))
        if count < 1 or count > 366:
            raise ValueError("'last N days' supports 1..366.")
        today = now.date()
        first = today - timedelta(days=count)
        days = [first + timedelta(days=i) for i in range(count)]
        return (datetime.combine(first, time.min, tzinfo=tz),
                datetime.combine(today, time.min, tzinfo=tz), days)
    try:
        day = date.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError('Invalid time. Use live, today, yesterday, '
                         '"last N days", or YYYY-MM-DD.') from exc
    start = datetime.combine(day, time.min, tzinfo=tz)
    return start, start + timedelta(days=1), [day]


def expand_index_pattern(pattern: str, days: Sequence[date]) -> str:
    if "{date}" not in pattern:
        return pattern
    return ",".join(pattern.replace("{date}", d.strftime("%Y.%m.%d"))
                    for d in days)


# ---------------------------------------------------------------------------
# Elasticsearch helpers
# ---------------------------------------------------------------------------
def create_es_client(target: ESTarget) -> Elasticsearch:
    options: Dict[str, Any] = {
        "request_timeout": target.request_timeout,
        "max_retries": target.max_retries,
        "retry_on_timeout": True,
        "verify_certs": target.verify_ssl,
    }
    if target.username:
        options["basic_auth"] = (target.username, target.password or "")
    if target.api_key:
        options["api_key"] = target.api_key
    if target.ca_cert:
        options["ca_certs"] = target.ca_cert
    if target.url.startswith("https://") and not target.verify_ssl:
        options["ssl_show_warn"] = False
    return Elasticsearch(target.url, **options)


def test_connection(es: Elasticsearch, target: ESTarget) -> None:
    last_error: Optional[Exception] = None
    for attempt in range(1, target.max_retries + 2):
        try:
            if es.ping(request_timeout=target.connect_timeout):
                return
            last_error = RuntimeError("Elasticsearch ping returned false.")
        except Exception as exc:
            last_error = exc
        if attempt <= target.max_retries:
            LOGGER.warning("[%s] Connection attempt %s failed. Retrying in "
                           "%s seconds.", target.name, attempt,
                           target.retry_delay)
            time_module.sleep(target.retry_delay)
    raise RuntimeError(f"Cannot connect to {target.url}: {last_error}")


def dotted_value(source: Mapping[str, Any], field_name: str) -> Any:
    if field_name in source:          # flat key first (e.g. "event.created")
        return source[field_name]
    current: Any = source
    for part in field_name.split("."):
        if not isinstance(current, Mapping) or part not in current:
            return None
        current = current[part]
    return current


def first_available(source: Mapping[str, Any], field_names: Sequence[str],
                    default: Any = "") -> Any:
    for field_name in field_names:
        value = dotted_value(source, field_name)
        if isinstance(value, list):
            value = value[0] if value else None
        if value not in (None, ""):
            return value
    return default


def parse_timestamp(value: Any) -> datetime:
    if isinstance(value, (int, float)):
        numeric = float(value)
        if numeric > 10_000_000_000:
            numeric /= 1000
        return datetime.fromtimestamp(numeric, tz=timezone.utc)
    if not isinstance(value, str):
        raise ValueError(f"Invalid timestamp value: {value!r}")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def aggregation_field(field_name: str) -> str:
    """Add .keyword for text fields; leave IPs, keywords, and fields the
    user already wrote with .keyword untouched."""
    if field_name.endswith(".keyword"):
        return field_name
    if field_name in IP_LIKE_FIELDS or field_name == "ClientID":
        return field_name
    return f"{field_name}.keyword"


def query_source_fields(settings: Settings) -> List[str]:
    fields = set(settings.arrival_fields) | set(settings.event_fields)
    fields.add(settings.primary_agg_field.replace(".keyword", ""))
    fields.update(settings.metadata_fields)
    return sorted(fields)


def build_search_body(settings: Settings, start: datetime, end: datetime,
                      after_key: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    arrival_field = settings.arrival_fields[0]
    composite: Dict[str, Any] = {
        "size": settings.page_size,
        "sources": [
            {"report_date": {"date_histogram": {
                "field": arrival_field, "calendar_interval": "1d",
                "time_zone": settings.timezone, "format": "yyyy-MM-dd"}}},
            {"device": {"terms": {
                "field": aggregation_field(settings.primary_agg_field),
                "missing_bucket": True}}},
            {"log_type": {"terms": {
                "field": aggregation_field(logtype_fields(settings)[0]),
                "missing_bucket": True}}},
        ],
    }
    if after_key:
        composite["after"] = dict(after_key)
    return {
        "size": 0,
        "track_total_hits": False,
        "query": {"range": {arrival_field: {
            "gte": start.isoformat(), "lt": end.isoformat()}}},
        "aggs": {"device_per_day": {
            "composite": composite,
            "aggs": {"latest_log": {"top_hits": {
                "size": 1,
                "sort": [{arrival_field: {"order": "desc",
                                          "unmapped_type": "date"}}],
                "_source": {"includes": query_source_fields(settings)},
            }}},
        }},
    }


def calculate_status(delay_minutes: Optional[float], warning: float,
                     critical: float) -> str:
    if delay_minutes is None:
        return "ERROR"
    if delay_minutes <= -warning:
        return "CLOCK_AHEAD"
    if delay_minutes >= critical:
        return "CRITICAL"
    if delay_minutes >= warning:
        return "DELAYED"
    return "OK"


def execute_search_with_retry(es: Elasticsearch, target: ESTarget,
                              index_pattern: str,
                              body: Mapping[str, Any]) -> Mapping[str, Any]:
    last_error: Optional[Exception] = None
    for attempt in range(1, target.max_retries + 2):
        try:
            return es.search(index=index_pattern, body=body,
                             request_timeout=target.request_timeout,
                             ignore_unavailable=True, allow_no_indices=True)
        except (ApiError, ESConnectionError, TimeoutError) as exc:
            last_error = exc
        if attempt <= target.max_retries:
            LOGGER.warning("[%s] Search attempt %s failed. Retrying in %s "
                           "seconds.", target.name, attempt,
                           target.retry_delay)
            time_module.sleep(target.retry_delay)
    raise RuntimeError(f"Search failed for target '{target.name}': "
                       f"{last_error}")


def collect_target_records(target: ESTarget, settings: Settings,
                           time_selection: str,
                           ) -> Tuple[List[DelayRecord], List[date]]:
    start, end, selected_days = resolve_time_range(time_selection,
                                                   settings.timezone)
    index_pattern = expand_index_pattern(target.index_pattern, selected_days)
    LOGGER.info("[%s] URL=%s index=%s range=%s to %s", target.name,
                target.url, index_pattern, start.isoformat(), end.isoformat())

    es = create_es_client(target)
    test_connection(es, target)

    records: List[DelayRecord] = []
    after_key: Optional[Mapping[str, Any]] = None

    while True:
        body = build_search_body(settings, start, end, after_key)
        response = execute_search_with_retry(es, target, index_pattern, body)
        aggregation = response.get("aggregations", {}).get("device_per_day",
                                                           {})
        buckets = aggregation.get("buckets", [])

        for bucket in buckets:
            hits = (bucket.get("latest_log", {}).get("hits", {})
                    .get("hits", []))
            if not hits:
                continue
            hit = hits[0]
            source = hit.get("_source", {})
            arrival_raw = first_available(source, settings.arrival_fields)
            event_raw = first_available(source, settings.event_fields)

            delay_minutes: Optional[float] = None
            error_text = ""
            try:
                arrival_dt = parse_timestamp(arrival_raw)
                event_dt = parse_timestamp(event_raw)
                delay_minutes = round(
                    (arrival_dt - event_dt).total_seconds() / 60, 2)
            except Exception as exc:
                error_text = str(exc)

            device = str(bucket.get("key", {}).get("device")
                         or first_available(
                             source, [settings.primary_agg_field],
                             "UNKNOWN_DEVICE"))
            log_type_value = str(
                bucket.get("key", {}).get("log_type")
                or first_available(source, logtype_fields(settings)) or "")
            metadata = {
                name: str(first_available(source, [name]))
                for name in settings.metadata_fields
            }
            status = calculate_status(delay_minutes,
                                      settings.delay_threshold_minutes,
                                      settings.critical_threshold_minutes)

            records.append(DelayRecord(
                es_name=target.name,
                es_url=target.url,
                index=str(hit.get("_index", "")),
                device=device,
                report_date=str(bucket.get("key", {}).get("report_date", "")),
                arrival_time=str(arrival_raw or ""),
                event_time=str(event_raw or ""),
                delay_minutes=delay_minutes,
                delay_status=status,
                log_type=log_type_value,
                metadata=metadata,
                error=error_text,
            ))

        after_key = aggregation.get("after_key")
        if not after_key or not buckets:
            break

    records.sort(key=lambda r: (r.es_name, r.device, r.log_type,
                                r.report_date))
    LOGGER.info("[%s] Collected %s device/day records.", target.name,
                len(records))
    return records, selected_days


# ---------------------------------------------------------------------------
# Shared aggregation helpers
# ---------------------------------------------------------------------------
def record_key(record: DelayRecord) -> Tuple[str, str, str]:
    return record.es_name, record.device, record.log_type


def latest_record_map(records: Iterable[DelayRecord],
                      ) -> Dict[Tuple[str, str, str], DelayRecord]:
    result: Dict[Tuple[str, str, str], DelayRecord] = {}
    for record in records:
        key = record_key(record)
        previous = result.get(key)
        if previous is None or record.report_date > previous.report_date:
            result[key] = record
    return result


def compute_trends(records: Sequence[DelayRecord],
                   report_dates: Sequence[str]) -> None:
    delay_lookup = {(*record_key(r), r.report_date): r.delay_minutes
                    for r in records}
    for key, latest in latest_record_map(records).items():
        values = [delay_lookup.get((*key, d)) for d in report_dates]
        available = [v for v in values if v is not None]
        if len(available) >= 2:
            diff = available[-1] - available[-2]
            if diff > 1:
                latest.trend = "WORSENING"
            elif diff < -1:
                latest.trend = "IMPROVING"
            else:
                latest.trend = "STABLE"
        else:
            latest.trend = "NO_TREND"


# ---------------------------------------------------------------------------
# Exact delay-scenario pattern engine
#
#   TZ_OFFSET    delay ~= a timezone offset (e.g. exactly 330 = UTC+05:30)
#                -> parser/fwd date filter timezone issue
#   UNEVEN       delay fluctuates (30, 20, 5, 100...) -> Redis/Kafka tuning
#                needed for that tag1 pipeline
#   OLD_LOGS     delay > 2000 min -> device pulling old logs; check sincedb /
#                last_run_metadata_path, adjust interval, run manually
#   LOGTYPE_ZONE same device: one log_type OK, another delayed -> zone value
#                mismatch in parser filters
# ---------------------------------------------------------------------------
TZ_OFFSETS_MINUTES = sorted({m for m in range(60, 841, 30)} | {345, 765})


def format_utc_offset(minutes: int, ahead: bool) -> str:
    sign = "-" if ahead else "+"
    return f"UTC{sign}{minutes // 60:02d}:{minutes % 60:02d}"


def match_tz_offset(delay: float, tolerance: float) -> Optional[int]:
    magnitude = abs(delay)
    for offset in TZ_OFFSETS_MINUTES:
        if abs(magnitude - offset) <= tolerance:
            return offset
    return None


def analyze_pattern(record: DelayRecord,
                    history: Sequence[Optional[float]],
                    settings: Settings) -> None:
    """Set record.pattern / reason / fix from the exact delay scenario."""
    delay = record.delay_minutes
    status = record.delay_status
    tag1 = record.meta("tag1") or "-"
    values = [v for v in history if v is not None]
    spread = (max(values) - min(values)) if len(values) >= 2 else 0.0

    if delay is None:
        record.pattern = "PARSE_ERROR"
        record.reason = short_reason(status, record.trend)
        record.fix = short_fix(status)
        return

    # Scenario: very long delay -> pulling OLD logs.
    if abs(delay) >= settings.very_long_delay_minutes:
        record.pattern = "OLD_LOGS"
        record.reason = (
            f"Very long delay ({delay} min >"
            f" {settings.very_long_delay_minutes:g}) - device/pipeline is"
            " pulling OLD logs, not live ones")
        record.fix = (
            "Check sincedb (Filebeat/Logstash file input) or"
            " last_run_metadata_path (JDBC input); change the schedule"
            " interval or run the pipeline manually and compare the actual"
            " delay")
        return

    # Scenario: delay == timezone offset (e.g. exactly ~330 min = UTC+5:30).
    tz_offset = match_tz_offset(delay, settings.tz_tolerance_minutes)
    stable = (len(values) < 2
              or spread <= 2 * settings.tz_tolerance_minutes)
    if tz_offset and stable and status != "OK":
        offset_text = format_utc_offset(tz_offset, ahead=delay < 0)
        hours, mins = divmod(tz_offset, 60)
        record.pattern = "TZ_OFFSET"
        record.reason = (
            f"Delay is exactly ~{abs(delay):g} min = {offset_text} offset"
            " - timezone issue, not a real pipeline lag")
        record.fix = (
            f"Add {'+' if delay > 0 else '-'}{hours}:{mins:02d} in the"
            " parser/fwd date filter (e.g. Logstash: date { timezone =>"
            " \"Asia/Kolkata\" } for +05:30); then delay returns to ~0")
        return

    # Scenario: uneven delay (30, 20, 5, 100 ...) -> queue oscillation.
    if len(values) >= 3 and spread >= settings.uneven_spread_minutes:
        record.pattern = "UNEVEN"
        record.reason = (
            f"Uneven delay (min {min(values):g} / max {max(values):g} min"
            f" across {len(values)} samples) - queue/buffer oscillation on"
            f" tag1='{tag1}' pipeline")
        record.fix = (
            f"Redis/Kafka fine-tuning required for the tag1='{tag1}'"
            " pipeline: check consumer lag, batch size, pipeline workers"
            " and broker memory")
        return

    record.pattern = "-" if status == "OK" else "GENERIC"
    record.reason = short_reason(status, record.trend)
    record.fix = short_fix(status)


def apply_cross_logtype_check(latest_records: Sequence[DelayRecord]) -> None:
    """Same device, one log_type on time while another is delayed ->
    zone value mismatch (or one zone filter applied to all log types)."""
    groups: Dict[Tuple[str, str], List[DelayRecord]] = {}
    for record in latest_records:
        groups.setdefault((record.es_name, record.device),
                          []).append(record)

    for group in groups.values():
        if len(group) < 2:
            continue
        ok = [r for r in group if r.delay_status == "OK"]
        bad = [r for r in group
               if r.delay_status in {"DELAYED", "CRITICAL"}]
        if not (ok and bad):
            continue
        ok_types = sorted({r.log_type or "?" for r in ok})
        ok_zones = sorted({r.meta("zone") or "?" for r in ok})
        for record in bad:
            # OLD_LOGS / TZ_OFFSET verdicts are more exact - keep them.
            if record.pattern in {"OLD_LOGS", "TZ_OFFSET"}:
                continue
            bad_zone = record.meta("zone") or "?"
            record.pattern = "LOGTYPE_ZONE"
            record.reason = (
                f"log_type '{record.log_type or '?'}' is delayed while"
                f" '{', '.join(ok_types)}' from the SAME device is on time"
                f" - zone mismatch: delayed zone='{bad_zone}' vs OK"
                f" zone='{', '.join(ok_zones)}' (or one zone filter applied"
                " to all log types)")
            record.fix = (
                f"Check the zone value stamped on log_type"
                f" '{record.log_type or '?'}' and correct it in that"
                " log_type's parser filter - do not reuse one zone filter"
                " for every log type of the device")


def annotate_records(records: Sequence[DelayRecord],
                     report_dates: Sequence[str],
                     settings: Settings) -> None:
    """Trend + exact pattern diagnosis for every latest device/logtype row."""
    compute_trends(records, report_dates)
    delay_lookup = {(*record_key(r), r.report_date): r.delay_minutes
                    for r in records}
    latest = latest_record_map(records)
    for key, record in latest.items():
        history = [delay_lookup.get((*key, d)) for d in report_dates]
        analyze_pattern(record, history, settings)
    apply_cross_logtype_check(list(latest.values()))


# ---------------------------------------------------------------------------
# XLSX report (single workbook for ALL ES URLs)
# ---------------------------------------------------------------------------
FILL = {
    "OK": PatternFill("solid", fgColor="C6EFCE"),
    "IMPROVING": PatternFill("solid", fgColor="C6EFCE"),
    "DELAYED": PatternFill("solid", fgColor="FFEB9C"),
    "WORSENING": PatternFill("solid", fgColor="FFC7A0"),
    "CRITICAL": PatternFill("solid", fgColor="FFC7CE"),
    "CLOCK_AHEAD": PatternFill("solid", fgColor="FFE4B5"),
    "ERROR": PatternFill("solid", fgColor="D9D9D9"),
    "NO_DATA": PatternFill("solid", fgColor="F2F2F2"),
    "STABLE": PatternFill("solid", fgColor="DDEBF7"),
}
FONT_COLOR = {
    "OK": "006100", "IMPROVING": "006100",
    "DELAYED": "9C6500", "WORSENING": "9C3400",
    "CRITICAL": "9C0006", "CLOCK_AHEAD": "9C6500",
    "ERROR": "3F3F3F", "NO_DATA": "808080", "STABLE": "1F4E78",
}
HEADER_FILL = PatternFill("solid", fgColor="1F4E78")
HEADER_FONT = Font(bold=True, color="FFFFFF")
TITLE_FONT = Font(bold=True, size=15, color="1F4E78")
THIN = Side(style="thin", color="D9D9D9")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def style_status_cell(cell: Any, status: str) -> None:
    if status in FILL:
        cell.fill = FILL[status]
        cell.font = Font(bold=status in {"CRITICAL", "DELAYED", "WORSENING"},
                         color=FONT_COLOR.get(status, "000000"))


def write_header_row(sheet: Worksheet, row: int, headers: Sequence[str],
                     start_col: int = 1) -> None:
    for offset, header in enumerate(headers):
        cell = sheet.cell(row=row, column=start_col + offset, value=header)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        cell.border = BORDER


def autosize(sheet: Worksheet, widths: Mapping[int, int]) -> None:
    for col, width in widths.items():
        sheet.column_dimensions[get_column_letter(col)].width = width


def delay_cell_status(delay: Optional[float], warning: float,
                      critical: float) -> str:
    if delay is None:
        return "NO_DATA"
    return calculate_status(delay, warning, critical)


# ---------------------------------------------------------------------------
# Configurable column order for the "Latest Status" sheet.
#
# config.yml:
#   output:
#     latest_status_columns:
#       - device
#       - log_type
#       - zone            # any metadata_fields name works directly
#       - tag1
#       - delay_minutes
#       - status
#       - "*metadata"     # expands to every metadata field not already used
#       - reason
#       - fix
#
# Omit the key entirely to keep the built-in default order.
# ---------------------------------------------------------------------------
BUILTIN_COLUMNS: Dict[str, Tuple[str, Any]] = {
    "es_name": ("ES Name", lambda r, s: r.es_name),
    "es_url": ("ES URL", lambda r, s: r.es_url),
    "index": ("Index", lambda r, s: r.index),
    "device": ("Device", lambda r, s: r.device),
    "log_type": ("Log Type", lambda r, s: r.log_type),
    "report_date": ("Report Date", lambda r, s: r.report_date),
    "event_time": ("Event Time", lambda r, s: r.event_time),
    "arrival_time": ("Arrival Time", lambda r, s: r.arrival_time),
    "delay_minutes": ("Delay (min)",
                      lambda r, s: (r.delay_minutes
                                    if r.delay_minutes is not None else "")),
    "status": ("Status", lambda r, s: r.delay_status),
    "trend": ("Trend", lambda r, s: r.trend),
    "pattern": ("Pattern", lambda r, s: r.pattern),
    "reason": ("Exact Reason", lambda r, s: r.reason),
    "fix": ("Recommended Fix", lambda r, s: r.fix),
    "error": ("Error", lambda r, s: r.error),
}

# Aliases so friendlier spellings in config.yml still resolve.
COLUMN_ALIASES = {
    "delay": "delay_minutes", "delay_min": "delay_minutes",
    "delay(min)": "delay_minutes", "delay_status": "status",
    "es": "es_name", "esname": "es_name", "device_name": "device",
    "logtype": "log_type", "date": "report_date",
    "exact_reason": "reason", "recommended_fix": "fix",
    "remediation": "fix",
}

DEFAULT_LATEST_COLUMNS = [
    "es_name", "device", "log_type", "report_date", "event_time",
    "arrival_time", "delay_minutes", "status", "trend", "pattern",
    "*metadata", "reason", "fix",
]

# Column key -> default Excel width. Anything unlisted falls back to 15.
COLUMN_WIDTHS = {
    "es_name": 14, "es_url": 30, "index": 24, "device": 26, "log_type": 20,
    "report_date": 12, "event_time": 24, "arrival_time": 24,
    "delay_minutes": 11, "status": 13, "trend": 12, "pattern": 15,
    "reason": 60, "fix": 60, "error": 30,
}


def resolve_columns(requested: Sequence[str], settings: Settings,
                    ) -> List[Tuple[str, str, Any]]:
    """Return [(key, header, getter)] honouring the configured order.

    '*metadata' expands to every metadata field not named explicitly.
    Unknown names are treated as metadata/source field names so any field
    in metadata_fields can be placed anywhere in the order.
    """
    named = {COLUMN_ALIASES.get(str(item).strip().lower(),
                                str(item).strip())
             for item in requested if str(item).strip() != "*metadata"}
    columns: List[Tuple[str, str, Any]] = []
    seen: set = set()

    for item in requested:
        raw = str(item).strip()
        key = COLUMN_ALIASES.get(raw.lower(), raw)

        if raw == "*metadata":
            for name in settings.metadata_fields:
                if name in named or name in seen:
                    continue
                seen.add(name)
                columns.append((name, name,
                                lambda r, s, n=name: r.meta(n)))
            continue

        if key in seen:
            continue
        seen.add(key)

        if key in BUILTIN_COLUMNS:
            header, getter = BUILTIN_COLUMNS[key]
            columns.append((key, header, getter))
        else:
            # Treat as a metadata / document field name.
            if key not in settings.metadata_fields:
                LOGGER.warning(
                    "Column '%s' is not a built-in column and is not in"
                    " metadata_fields - it will be blank. Add it to"
                    " metadata_fields to populate it.", key)
            columns.append((key, key, lambda r, s, n=key: r.meta(n)))

    if not columns:
        raise ValueError("latest_status_columns resolved to no columns.")
    return columns


def latest_status_column_config(config: Mapping[str, Any],
                                ) -> List[str]:
    output_config = config.get("output", {})
    if not isinstance(output_config, Mapping):
        output_config = {}
    requested = output_config.get(
        "latest_status_columns", config.get("latest_status_columns"))
    if requested is None:
        return list(DEFAULT_LATEST_COLUMNS)
    if not isinstance(requested, list) or not requested:
        raise ValueError("output.latest_status_columns must be a non-empty"
                         " list of column names.")
    return [str(item) for item in requested]


def build_xlsx_report(output_path: Path, records: Sequence[DelayRecord],
                      selected_days: Sequence[date],
                      targets: Sequence[ESTarget],
                      settings: Settings,
                      time_selection: str,
                      latest_columns: Optional[Sequence[str]] = None,
                      ) -> None:
    latest_columns = (list(latest_columns) if latest_columns
                      else list(DEFAULT_LATEST_COLUMNS))
    report_dates = sorted({d.isoformat() for d in selected_days}
                          | {r.report_date for r in records if r.report_date})
    annotate_records(records, report_dates, settings)
    latest_map = latest_record_map(records)
    latest_records = sorted(
        latest_map.values(),
        key=lambda r: (STATUS_ORDER.index(r.delay_status)
                       if r.delay_status in STATUS_ORDER else 99,
                       -(r.delay_minutes or 0)))
    latest_date = report_dates[-1] if report_dates else ""
    warning = settings.delay_threshold_minutes
    critical = settings.critical_threshold_minutes
    meta_fields = settings.metadata_fields

    workbook = Workbook()

    # ---------------- Sheet 1: Overall Summary ----------------
    summary = workbook.active
    summary.title = "Overall Summary"
    summary.sheet_view.showGridLines = False

    summary["B2"] = "Elasticsearch Log Delay Report - All Clusters"
    summary["B2"].font = TITLE_FONT
    summary["B3"] = (
        f"Generated: "
        f"{datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S %Z')}"
        f"   |   Window: {time_selection}"
        f"   |   ES clusters: {len(targets)}"
        f"   |   Thresholds: warning >= {warning} min,"
        f" critical >= {critical} min")
    summary["B3"].font = Font(color="667085")

    counts = {status: sum(r.delay_status == status for r in latest_records)
              for status in STATUS_ORDER}
    total_devices = len(latest_records)
    healthy_pct = (round(100 * counts["OK"] / total_devices, 1)
                   if total_devices else 0)

    cards = [
        ("Total devices", total_devices, None),
        ("Healthy (OK)", counts["OK"], "OK"),
        ("Delayed", counts["DELAYED"], "DELAYED"),
        ("Critical", counts["CRITICAL"], "CRITICAL"),
        ("Clock ahead", counts["CLOCK_AHEAD"], "CLOCK_AHEAD"),
        ("Errors", counts["ERROR"], "ERROR"),
        ("Health %", f"{healthy_pct}%", None),
    ]
    for i, (label, value, status) in enumerate(cards):
        col = 2 + i * 2
        summary.cell(row=5, column=col, value=label).font = Font(
            bold=True, size=9, color="667085")
        value_cell = summary.cell(row=6, column=col, value=value)
        value_cell.font = Font(bold=True, size=16,
                               color=FONT_COLOR.get(status, "000000"))
        if status:
            value_cell.fill = FILL[status]

    summary.cell(row=9, column=2,
                 value=f"Per-Elasticsearch Cluster Summary "
                       f"(latest day: {latest_date})"
                 ).font = Font(bold=True, size=12)
    headers = ["ES Name", "ES URL", "Devices", "OK", "Delayed", "Critical",
               "Clock Ahead", "Errors", "Avg Delay (min)", "Max Delay (min)",
               "Worst Device", "Overall Verdict"]
    write_header_row(summary, 10, headers, start_col=2)

    row = 11
    for target in targets:
        cluster = [r for r in latest_records if r.es_name == target.name]
        delays = [r.delay_minutes for r in cluster
                  if r.delay_minutes is not None]
        worst = max(cluster,
                    key=lambda r: (r.delay_minutes
                                   if r.delay_minutes is not None
                                   else float("-inf")),
                    default=None)
        crit = sum(r.delay_status == "CRITICAL" for r in cluster)
        dela = sum(r.delay_status == "DELAYED" for r in cluster)
        verdict = ("NO_DATA" if not cluster else
                   "CRITICAL" if crit else
                   "DELAYED" if dela else "OK")
        values = [
            target.name, target.url, len(cluster),
            sum(r.delay_status == "OK" for r in cluster), dela, crit,
            sum(r.delay_status == "CLOCK_AHEAD" for r in cluster),
            sum(r.delay_status == "ERROR" for r in cluster),
            round(mean(delays), 2) if delays else "",
            round(max(delays), 2) if delays else "",
            (f"{worst.device} ({worst.delay_minutes} min)"
             if worst and worst.delay_minutes is not None else ""),
            verdict,
        ]
        for offset, value in enumerate(values):
            summary.cell(row=row, column=2 + offset, value=value
                         ).border = BORDER
        style_status_cell(summary.cell(row=row, column=13), verdict)
        row += 1

    row += 2
    summary.cell(row=row, column=2,
                 value="Top 15 Problematic Devices (all clusters)"
                 ).font = Font(bold=True, size=12)
    row += 1
    write_header_row(summary, row,
                     ["ES Name", "Device", "Log Type", "src_ip", "zone",
                      "tag1", settings.client_id_field, "Status",
                      "Delay (min)", "Trend", "Pattern", "Exact Reason",
                      "Quick Fix"], start_col=2)
    row += 1
    problematic = [r for r in latest_records if r.delay_status != "OK"][:15]
    for record in problematic:
        values = [record.es_name, record.device, record.log_type,
                  record.meta("src_ip"), record.meta("zone"),
                  record.meta("tag1"),
                  record.meta(settings.client_id_field),
                  record.delay_status,
                  record.delay_minutes
                  if record.delay_minutes is not None else "",
                  record.trend, record.pattern, record.reason, record.fix]
        for offset, value in enumerate(values):
            summary.cell(row=row, column=2 + offset, value=value
                         ).border = BORDER
        style_status_cell(summary.cell(row=row, column=9),
                          record.delay_status)
        style_status_cell(summary.cell(row=row, column=11), record.trend)
        row += 1
    if not problematic:
        summary.cell(row=row, column=2,
                     value="All devices healthy - no problems found."
                     ).font = Font(color="006100", bold=True)

    autosize(summary, {2: 16, 3: 34, 4: 10, 5: 8, 6: 10, 7: 10, 8: 12,
                       9: 10, 10: 15, 11: 15, 12: 30, 13: 14})

    # ---------------- Sheet 2: Latest Status ----------------
    latest_sheet = workbook.create_sheet("Latest Status")
    columns = resolve_columns(latest_columns, settings)
    headers = [header for _, header, _ in columns]
    write_header_row(latest_sheet, 1, headers)

    # Column positions are looked up by key, so styling follows whatever
    # order the user configured.
    position = {key: index for index, (key, _, _) in enumerate(columns, 1)}

    for r_index, record in enumerate(latest_records, start=2):
        for c_index, (key, _, getter) in enumerate(columns, start=1):
            cell = latest_sheet.cell(row=r_index, column=c_index,
                                     value=getter(record, settings))
            cell.border = BORDER
        if "status" in position:
            style_status_cell(
                latest_sheet.cell(row=r_index, column=position["status"]),
                record.delay_status)
        if "trend" in position:
            style_status_cell(
                latest_sheet.cell(row=r_index, column=position["trend"]),
                record.trend)
        if "delay_minutes" in position:
            style_status_cell(
                latest_sheet.cell(row=r_index,
                                  column=position["delay_minutes"]),
                record.delay_status)
    latest_sheet.freeze_panes = "A2"
    latest_sheet.auto_filter.ref = (
        f"A1:{get_column_letter(len(headers))}"
        f"{max(len(latest_records) + 1, 2)}")
    autosize(latest_sheet,
             {index: COLUMN_WIDTHS.get(key, 15)
              for index, (key, _, _) in enumerate(columns, 1)})

    # ---------------- Sheet 3: Daily Trend (pivot) ----------------
    trend_sheet = workbook.create_sheet("Daily Trend")
    delay_lookup = {(*record_key(r), r.report_date): r.delay_minutes
                    for r in records}
    headers = (["ES Name", "Device", "Log Type", "src_ip", "zone", "tag1"]
               + [f"{d} (min)" for d in report_dates]
               + ["Trend", "Latest vs Previous (min)"])
    write_header_row(trend_sheet, 1, headers)
    for r_index, record in enumerate(
            sorted(latest_map.values(), key=record_key), start=2):
        key = record_key(record)
        base = [record.es_name, record.device, record.log_type,
                record.meta("src_ip"), record.meta("zone"),
                record.meta("tag1")]
        for offset, value in enumerate(base):
            trend_sheet.cell(row=r_index, column=1 + offset, value=value
                             ).border = BORDER
        values = [delay_lookup.get((*key, d)) for d in report_dates]
        for offset, value in enumerate(values):
            cell = trend_sheet.cell(row=r_index, column=7 + offset,
                                    value="" if value is None else value)
            cell.border = BORDER
            style_status_cell(cell,
                              delay_cell_status(value, warning, critical))
        available = [v for v in values if v is not None]
        difference = (round(available[-1] - available[-2], 2)
                      if len(available) >= 2 else "")
        trend_cell = trend_sheet.cell(row=r_index,
                                      column=7 + len(report_dates),
                                      value=record.trend)
        trend_cell.border = BORDER
        style_status_cell(trend_cell, record.trend)
        trend_sheet.cell(row=r_index, column=8 + len(report_dates),
                         value=difference).border = BORDER
    trend_sheet.freeze_panes = "G2"
    autosize(trend_sheet, {1: 14, 2: 24, 3: 14, 4: 15, 5: 10, 6: 10,
                           **{7 + i: 14 for i in range(len(report_dates))},
                           7 + len(report_dates): 13,
                           8 + len(report_dates): 20})

    # ---------------- Sheet 4: Detail ----------------
    detail_sheet = workbook.create_sheet("Detail")
    headers = (["ES Name", "ES URL", "Index", "Device", "Log Type",
                "Report Date", "Event Time", "Arrival Time", "Delay (min)",
                "Status"]
               + meta_fields + ["Error"])
    write_header_row(detail_sheet, 1, headers)
    for r_index, record in enumerate(records, start=2):
        values = ([record.es_name, record.es_url, record.index,
                   record.device, record.log_type, record.report_date,
                   record.event_time, record.arrival_time,
                   record.delay_minutes
                   if record.delay_minutes is not None else "",
                   record.delay_status]
                  + [record.meta(name) for name in meta_fields]
                  + [record.error])
        for offset, value in enumerate(values):
            detail_sheet.cell(row=r_index, column=1 + offset, value=value)
        style_status_cell(detail_sheet.cell(row=r_index, column=10),
                          record.delay_status)
    detail_sheet.freeze_panes = "A2"
    detail_sheet.auto_filter.ref = (
        f"A1:{get_column_letter(len(headers))}{max(len(records) + 1, 2)}")
    autosize(detail_sheet, {1: 14, 2: 30, 3: 24, 4: 24, 5: 14, 6: 12,
                            7: 22, 8: 22, 9: 11, 10: 13,
                            **{11 + i: 15 for i in range(len(meta_fields))},
                            11 + len(meta_fields): 30})

    # ---------------- Sheet 5: Why & Fix Guide ----------------
    guide = workbook.create_sheet("Why & Fix Guide")
    guide.sheet_view.showGridLines = False
    guide["B2"] = "Why Log Delay Happens - and How to Fix It"
    guide["B2"].font = TITLE_FONT
    guide["B3"] = ("Delay (minutes) = Elasticsearch arrival time (@timestamp)"
                   " - original event time on the device.")
    guide["B3"].font = Font(italic=True, color="667085")

    row = 5
    for status in ["CRITICAL", "DELAYED", "CLOCK_AHEAD", "ERROR",
                   "NO_DATA", "OK"]:
        reasons, fixes = DIAGNOSIS[status]
        cell = guide.cell(row=row, column=2, value=f"Status: {status}")
        cell.font = Font(bold=True, size=12)
        style_status_cell(cell, status)
        row += 1
        guide.cell(row=row, column=2, value="Likely reasons"
                   ).font = Font(bold=True, color="667085")
        row += 1
        for reason in reasons:
            guide.cell(row=row, column=3, value=f"- {reason}")
            row += 1
        guide.cell(row=row, column=2, value="How to remediate"
                   ).font = Font(bold=True, color="667085")
        row += 1
        for fix in fixes:
            guide.cell(row=row, column=3, value=fix)
            row += 1
        row += 1

    row += 1
    guide.cell(row=row, column=2, value="Known Delay Patterns"
               ).font = Font(bold=True, size=13, color="1F4E78")
    row += 2
    known_patterns = [
        ("TZ_OFFSET  (e.g. exactly ~330 min)",
         "Delay equals a timezone offset: 330 min = UTC+05:30. The"
         " parser/forwarder is stamping local time as UTC - not a real"
         " pipeline lag.",
         "Add +05:30 in the parser/fwd date filter (Logstash: date {"
         " timezone => \"Asia/Kolkata\" }). Delay returns to ~0 after the"
         " fix."),
        ("UNEVEN  (e.g. 30, 20, 5, 100 min)",
         "Delay fluctuates between checks - queue/buffer oscillation in"
         " the pipeline for that tag1.",
         "Redis/Kafka fine-tuning required for the tag1 pipeline: check"
         " consumer lag, batch size, pipeline workers and broker memory."),
        ("OLD_LOGS  (more than 2000 min)",
         "Device/pipeline is pulling OLD logs, not live ones.",
         "Check sincedb (file input) or last_run_metadata_path (JDBC"
         " input); change the schedule interval or run the pipeline"
         " manually and check the actual delay."),
        ("LOGTYPE_ZONE  (one log_type OK, another delayed, SAME device)",
         "The delayed log_type carries a different zone value, or one"
         " zone filter was applied to all log types of the device.",
         "Check the zone value on the delayed logs and correct it in that"
         " log_type's parser filter."),
    ]
    for name, why, fix_text in known_patterns:
        guide.cell(row=row, column=2, value=name).font = Font(bold=True)
        row += 1
        guide.cell(row=row, column=3, value=f"Why : {why}")
        row += 1
        guide.cell(row=row, column=3, value=f"Fix : {fix_text}")
        row += 2
    autosize(guide, {2: 22, 3: 100})

    workbook.save(output_path)
    LOGGER.info("XLSX workbook created: %s", output_path)


# ---------------------------------------------------------------------------
# Forward collected data to destination Elasticsearch (optional)
# ---------------------------------------------------------------------------
def forward_to_output_es(config: Mapping[str, Any],
                         records: Sequence[DelayRecord],
                         time_selection: str) -> None:
    out_config = config.get("output_elasticsearch", {})
    if not isinstance(out_config, Mapping) or not out_config.get("enabled"):
        return

    url = normalize_url(str(out_config.get("url", "")))
    username = os.getenv("OUTPUT_ES_USER") or out_config.get("username")
    password = os.getenv("OUTPUT_ES_PASS") or out_config.get("password")
    index_prefix = str(out_config.get("index_prefix", "log-delay"))
    verify_certs = bool(out_config.get("verify_certs", False))
    pipeline = str(out_config.get("pipeline", "") or "")

    index_name = f"{index_prefix}-{datetime.now():%Y.%m}"

    options: Dict[str, Any] = {
        "request_timeout": 60,
        "verify_certs": verify_certs,
    }
    if username:
        options["basic_auth"] = (str(username), str(password or ""))
    if url.startswith("https://") and not verify_certs:
        options["ssl_show_warn"] = False

    es = Elasticsearch(url, **options)

    now_iso = datetime.now(timezone.utc).isoformat()

    def actions() -> Iterable[Dict[str, Any]]:
        for record in records:
            document: Dict[str, Any] = {
                "@timestamp": now_iso,
                "report_window": time_selection,
                "es_name": record.es_name,
                "es_url": record.es_url,
                "source_index": record.index,
                "device": record.device,
                "log_type": record.log_type,
                "report_date": record.report_date,
                "event_time": record.event_time,
                "arrival_time": record.arrival_time,
                "delay_minutes": record.delay_minutes,
                "delay_status": record.delay_status,
                "trend": record.trend,
                "pattern": record.pattern,
                "reason": record.reason,
                "error": record.error,
            }
            document.update({k: v for k, v in record.metadata.items() if v})
            # Deterministic _id -> re-runs update instead of duplicating.
            doc_id = (f"{record.es_name}|{record.device}|"
                      f"{record.log_type}|{record.report_date}")
            action: Dict[str, Any] = {
                "_op_type": "index",
                "_index": index_name,
                "_id": doc_id,
                "_source": document,
            }
            if pipeline:
                action["pipeline"] = pipeline
            yield action

    success, errors = helpers.bulk(es, actions(), raise_on_error=False,
                                   stats_only=False)
    LOGGER.info("Forwarded %s delay docs to %s (%s)", success, url,
                index_name)
    if errors:
        LOGGER.warning("Output ES bulk errors (%s): first error: %s",
                       len(errors), errors[0])


# ---------------------------------------------------------------------------
# Email (Office 365 / STARTTLS, flat keys)
# ---------------------------------------------------------------------------
def email_recipients(email_config: Mapping[str, Any],
                     ) -> Tuple[List[str], List[str], List[str]]:
    recipients = email_config.get("recipients", {})
    if not isinstance(recipients, Mapping):
        recipients = {}
    to_value = recipients.get("to", email_config.get("to", []))
    cc_value = recipients.get("cc", email_config.get("cc", []))
    bcc_value = recipients.get("bcc", email_config.get("bcc", []))

    def normalize(value: Any) -> List[str]:
        if value is None:
            return []
        if isinstance(value, str):
            return [value]
        if isinstance(value, list):
            return [str(item) for item in value if str(item).strip()]
        raise ValueError("Email recipients must be a string or list.")

    return normalize(to_value), normalize(cc_value), normalize(bcc_value)


def build_email_summary(records: Sequence[DelayRecord],
                        settings: Settings) -> str:
    latest_records = list(latest_record_map(records).values())
    total = len(latest_records)
    count = {s: sum(r.delay_status == s for r in latest_records)
             for s in STATUS_ORDER}

    problematic = sorted(
        [r for r in latest_records if r.delay_status != "OK"],
        key=lambda r: (r.delay_minutes if r.delay_minutes is not None
                       else float("-inf")),
        reverse=True)[:20]

    lines = [
        "Hello Team,",
        "",
        "Please find the attached consolidated Elasticsearch log delay"
        " report (XLSX) covering all clusters.",
        "",
        "Latest Status Summary",
        "---------------------",
        f"Total devices : {total}",
        f"Healthy       : {count['OK']}",
        f"Delayed       : {count['DELAYED']}",
        f"Critical      : {count['CRITICAL']}",
        f"Clock ahead   : {count['CLOCK_AHEAD']}",
        f"Errors        : {count['ERROR']}",
    ]
    if problematic:
        lines += ["", "Top Problematic Devices", "-----------------------"]
        for record in problematic:
            delay_text = ("N/A" if record.delay_minutes is None
                          else f"{record.delay_minutes} min")
            lines.append(
                f"{record.es_name} | {record.device} | "
                f"{record.log_type or '-'} | "
                f"zone={record.meta('zone') or '-'} | "
                f"tag1={record.meta('tag1') or '-'} | "
                f"{record.delay_status} | {delay_text} | "
                f"[{record.pattern}] {record.reason}")
        lines += ["", "See the 'Why & Fix Guide' sheet in the attachment"
                      " for remediation steps."]
    lines += ["", "Regards,", "Elasticsearch Log Delay Finder"]
    return "\n".join(lines)


def status_colors(status: str) -> Tuple[str, str]:
    """(background, text) hex pair for a status chip."""
    return {
        "OK": ("#ecfdf3", "#027a48"),
        "DELAYED": ("#fffaeb", "#b54708"),
        "CRITICAL": ("#fef3f2", "#b42318"),
        "CLOCK_AHEAD": ("#fff6ed", "#c4320a"),
        "ERROR": ("#f2f4f7", "#475467"),
        "NO_DATA": ("#f9fafb", "#667085"),
        "WORSENING": ("#fef3f2", "#b42318"),
        "IMPROVING": ("#ecfdf3", "#027a48"),
        "STABLE": ("#eff8ff", "#175cd3"),
    }.get(status, ("#f9fafb", "#344054"))


# Inline styles - Outlook/O365 drops <style> blocks, so every rule
# has to sit on the element itself.
TD = ("padding:7px 10px;border-bottom:1px solid #eaecf0;"
      "font-size:12px;color:#344054;white-space:nowrap;")
TH = ("padding:8px 10px;background:#1f4e78;color:#ffffff;font-size:11px;"
      "text-transform:uppercase;letter-spacing:.4px;text-align:left;"
      "white-space:nowrap;")


def kpi_card(label: str, value: Any, status: Optional[str] = None) -> str:
    background, color = (status_colors(status) if status
                         else ("#f9fafb", "#101828"))
    return (
        f'<td style="padding:4px;" width="14%">'
        f'<div style="background:{background};border:1px solid #eaecf0;'
        f'border-radius:8px;padding:10px 8px;text-align:center;">'
        f'<div style="font-size:10px;color:#667085;text-transform:uppercase;'
        f'letter-spacing:.4px;">{escape_html(label)}</div>'
        f'<div style="font-size:22px;font-weight:bold;color:{color};'
        f'padding-top:3px;">{escape_html(value)}</div>'
        f"</div></td>")


def escape_html(value: Any) -> str:
    return html.escape(str(value if value not in (None, "") else "-"))


def status_chip(status: str) -> str:
    background, color = status_colors(status)
    return (f'<span style="background:{background};color:{color};'
            f'padding:2px 8px;border-radius:10px;font-size:11px;'
            f'font-weight:bold;">{escape_html(status)}</span>')


def build_email_html(records: Sequence[DelayRecord], settings: Settings,
                     targets: Sequence[ESTarget],
                     time_selection: str) -> str:
    latest_records = list(latest_record_map(records).values())
    total = len(latest_records)
    count = {s: sum(r.delay_status == s for r in latest_records)
             for s in STATUS_ORDER}
    healthy_pct = round(100 * count["OK"] / total, 1) if total else 0

    problematic = sorted(
        [r for r in latest_records if r.delay_status != "OK"],
        key=lambda r: (r.delay_minutes if r.delay_minutes is not None
                       else float("-inf")),
        reverse=True)[:20]

    generated = datetime.now().astimezone().strftime(
        "%Y-%m-%d %H:%M:%S %Z")

    cards = "".join([
        kpi_card("Devices", total),
        kpi_card("Healthy", count["OK"], "OK"),
        kpi_card("Delayed", count["DELAYED"], "DELAYED"),
        kpi_card("Critical", count["CRITICAL"], "CRITICAL"),
        kpi_card("Clock ahead", count["CLOCK_AHEAD"], "CLOCK_AHEAD"),
        kpi_card("Errors", count["ERROR"], "ERROR"),
        kpi_card("Health", f"{healthy_pct}%"),
    ])

    # Per-cluster rows
    cluster_rows = []
    for target in targets:
        cluster = [r for r in latest_records if r.es_name == target.name]
        delays = [r.delay_minutes for r in cluster
                  if r.delay_minutes is not None]
        crit = sum(r.delay_status == "CRITICAL" for r in cluster)
        dela = sum(r.delay_status == "DELAYED" for r in cluster)
        verdict = ("NO_DATA" if not cluster else "CRITICAL" if crit
                   else "DELAYED" if dela else "OK")
        cluster_rows.append(
            f"<tr>"
            f'<td style="{TD}"><b>{escape_html(target.name)}</b></td>'
            f'<td style="{TD}">{escape_html(len(cluster))}</td>'
            f'<td style="{TD}">{escape_html(sum(r.delay_status == "OK" for r in cluster))}</td>'
            f'<td style="{TD}">{escape_html(dela)}</td>'
            f'<td style="{TD}">{escape_html(crit)}</td>'
            f'<td style="{TD}">{escape_html(round(mean(delays), 2) if delays else "-")}</td>'
            f'<td style="{TD}">{escape_html(round(max(delays), 2) if delays else "-")}</td>'
            f'<td style="{TD}">{status_chip(verdict)}</td>'
            f"</tr>")

    # Problem rows - zone and tag1 always shown
    problem_rows = []
    for record in problematic:
        background, _ = status_colors(record.delay_status)
        delay_text = ("N/A" if record.delay_minutes is None
                      else f"{record.delay_minutes}")
        problem_rows.append(
            f'<tr style="background:{background};">'
            f'<td style="{TD}">{escape_html(record.es_name)}</td>'
            f'<td style="{TD}"><b>{escape_html(record.device)}</b></td>'
            f'<td style="{TD}">{escape_html(record.log_type)}</td>'
            f'<td style="{TD}">{escape_html(record.meta("zone"))}</td>'
            f'<td style="{TD}">{escape_html(record.meta("tag1"))}</td>'
            f'<td style="{TD}">{status_chip(record.delay_status)}</td>'
            f'<td style="{TD}"><b>{escape_html(delay_text)}</b></td>'
            f'<td style="{TD}">{escape_html(record.pattern)}</td>'
            f'<td style="{TD}white-space:normal;min-width:260px;">'
            f'{escape_html(record.reason)}</td>'
            f'<td style="{TD}white-space:normal;min-width:260px;'
            f'color:#175cd3;">{escape_html(record.fix)}</td>'
            f"</tr>")

    if problem_rows:
        problem_section = (
            f'<h3 style="font-size:14px;color:#101828;margin:22px 0 8px;">'
            f"Top {len(problem_rows)} problematic devices "
            f"&mdash; exact reason and fix</h3>"
            f'<table cellpadding="0" cellspacing="0" border="0" '
            f'style="border-collapse:collapse;width:100%;'
            f'border:1px solid #eaecf0;">'
            f"<tr>"
            + "".join(f'<th style="{TH}">{header}</th>' for header in
                      ["ES", "Device", "Log type", "Zone", "tag1", "Status",
                       "Delay (min)", "Pattern", "Exact reason",
                       "Recommended fix"])
            + "</tr>" + "".join(problem_rows) + "</table>")
    else:
        problem_section = (
            '<p style="background:#ecfdf3;border:1px solid #a6f4c5;'
            'border-radius:8px;padding:12px;color:#027a48;font-size:13px;">'
            "All devices are healthy &mdash; no delayed, critical or"
            " errored devices in this window.</p>")

    return f"""<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f7fb;">
<table cellpadding="0" cellspacing="0" border="0" width="100%"
       style="background:#f4f7fb;padding:20px 0;">
<tr><td align="center">
<table cellpadding="0" cellspacing="0" border="0" width="960"
       style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;
              padding:24px;font-family:Segoe UI,Arial,Helvetica,sans-serif;">
<tr><td>

<h2 style="margin:0 0 4px;font-size:19px;color:#1f4e78;">
Elasticsearch Log Delay Report</h2>
<div style="font-size:12px;color:#667085;margin-bottom:18px;">
Generated: {escape_html(generated)} &nbsp;|&nbsp;
Window: <b>{escape_html(time_selection)}</b> &nbsp;|&nbsp;
Clusters: <b>{len(targets)}</b> &nbsp;|&nbsp;
Thresholds: warning &ge; {settings.delay_threshold_minutes:g} min,
critical &ge; {settings.critical_threshold_minutes:g} min
</div>

<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>{cards}</tr>
</table>

<h3 style="font-size:14px;color:#101828;margin:22px 0 8px;">
Per-cluster summary</h3>
<table cellpadding="0" cellspacing="0" border="0"
       style="border-collapse:collapse;width:100%;border:1px solid #eaecf0;">
<tr>{"".join(f'<th style="{TH}">{h}</th>' for h in
             ["ES name", "Devices", "OK", "Delayed", "Critical",
              "Avg delay", "Max delay", "Verdict"])}</tr>
{"".join(cluster_rows)}
</table>

{problem_section}

<p style="font-size:12px;color:#667085;margin-top:20px;line-height:1.6;">
The attached XLSX contains the full device list, the daily delay trend and
the <b>Why &amp; Fix Guide</b> sheet with remediation steps for every
delay pattern.
</p>

<div style="border-top:1px solid #eaecf0;margin-top:18px;padding-top:12px;
            font-size:11px;color:#98a2b3;">
Elasticsearch Log Delay Finder &mdash; automated report, please do not
reply to this mail.
</div>

</td></tr></table>
</td></tr></table>
</body></html>"""


def send_email(email_config: Mapping[str, Any],
               records: Sequence[DelayRecord],
               settings: Settings,
               targets: Sequence[ESTarget],
               attachments: Sequence[Path],
               time_selection: str) -> None:
    smtp_config = email_config.get("smtp", {})
    if not isinstance(smtp_config, Mapping):
        smtp_config = {}

    smtp_host = str(email_config.get(
        "smtp_host", smtp_config.get("host", ""))).strip()
    smtp_port = int(email_config.get(
        "smtp_port", smtp_config.get("port", 587)))
    tls_mode = str(email_config.get(
        "tls", smtp_config.get("tls", "starttls"))).strip().lower()
    smtp_user = (os.getenv("SMTP_USER") or email_config.get("smtp_user")
                 or smtp_config.get("username"))
    smtp_password = (os.getenv("SMTP_PASS") or email_config.get("smtp_pass")
                     or smtp_config.get("password"))
    smtp_timeout = int(email_config.get(
        "timeout", smtp_config.get("timeout", 30)))

    sender_email = str(email_config.get("from", smtp_user or "")).strip()
    sender_name = str(email_config.get(
        "sender_name", "Elasticsearch Log Delay Finder")).strip()

    to_addr, cc_addr, bcc_addr = email_recipients(email_config)

    if not smtp_host:
        raise ValueError("SMTP host is missing.")
    if not sender_email:
        raise ValueError("Email 'from' address is missing.")
    if not (to_addr or cc_addr or bcc_addr):
        raise ValueError("No email recipients are configured.")

    subject_prefix = str(email_config.get(
        "subject_prefix",
        email_config.get("subject", "Elasticsearch Log Delay Report")))
    subject = (f"{subject_prefix} - "
               f"{datetime.now().strftime('%Y-%m-%d')} - {time_selection}")

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = (f"{sender_name} <{sender_email}>"
                       if sender_name else sender_email)
    if to_addr:
        message["To"] = ", ".join(to_addr)
    if cc_addr:
        message["Cc"] = ", ".join(cc_addr)
    message.set_content(build_email_summary(records, settings))
    message.add_alternative(
        build_email_html(records, settings, targets, time_selection),
        subtype="html")

    for attachment_path in attachments:
        if not attachment_path.is_file():
            continue
        with attachment_path.open("rb") as handle:
            message.add_attachment(
                handle.read(),
                maintype="application",
                subtype=("vnd.openxmlformats-officedocument."
                         "spreadsheetml.sheet"
                         if attachment_path.suffix == ".xlsx"
                         else "octet-stream"),
                filename=attachment_path.name)

    all_recipients = to_addr + cc_addr + bcc_addr
    context = ssl.create_default_context()

    if tls_mode in {"ssl", "smtps"}:
        with smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=smtp_timeout,
                              context=context) as smtp:
            if smtp_user:
                smtp.login(str(smtp_user), str(smtp_password or ""))
            smtp.send_message(message, from_addr=sender_email,
                              to_addrs=all_recipients)
    else:
        with smtplib.SMTP(smtp_host, smtp_port, timeout=smtp_timeout) as smtp:
            smtp.ehlo()
            if tls_mode in {"starttls", "tls"}:
                smtp.starttls(context=context)
                smtp.ehlo()
            if smtp_user:
                smtp.login(str(smtp_user), str(smtp_password or ""))
            smtp.send_message(message, from_addr=sender_email,
                              to_addrs=all_recipients)

    LOGGER.info("Email sent successfully to: %s", ", ".join(all_recipients))


def has_problems(records: Sequence[DelayRecord]) -> bool:
    return any(r.delay_status != "OK"
               for r in latest_record_map(records).values())


def clean_old_reports(output_directory: Path, retention_days: int) -> None:
    if retention_days <= 0:
        return
    cutoff = datetime.now().timestamp() - retention_days * 86400
    for path in output_directory.iterdir():
        if path.is_file() and path.stat().st_mtime < cutoff:
            try:
                path.unlink()
                LOGGER.info("Deleted old report: %s", path)
            except OSError as exc:
                LOGGER.warning("Unable to delete %s: %s", path, exc)


# ---------------------------------------------------------------------------
# Realtime single-device mode
# ---------------------------------------------------------------------------
class Color:
    enabled = sys.stdout.isatty() and os.getenv("NO_COLOR") is None

    @classmethod
    def wrap(cls, text: str, code: str) -> str:
        return f"\033[{code}m{text}\033[0m" if cls.enabled else text

    @classmethod
    def bold(cls, text: str) -> str:
        return cls.wrap(text, "1")

    @classmethod
    def status(cls, status: str) -> str:
        codes = {"OK": "1;32", "DELAYED": "1;33", "CRITICAL": "1;31",
                 "CLOCK_AHEAD": "1;35", "ERROR": "1;90", "NO_DATA": "90"}
        return cls.wrap(status, codes.get(status, "0"))


def prompt_if_missing(value: Optional[str], prompt: str,
                      secret: bool = False,
                      default: Optional[str] = None) -> str:
    if value:
        return value
    suffix = f" [{default}]" if default else ""
    while True:
        if secret:
            answer = getpass.getpass(f"{prompt}{suffix}: ")
        else:
            answer = input(f"{prompt}{suffix}: ").strip()
        if answer:
            return answer
        if default is not None:
            return default
        print("  A value is required.")


def looks_like_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def single_target_from_args(args: argparse.Namespace,
                            config: Mapping[str, Any]) -> ESTarget:
    """Build a one-off ESTarget from CLI args + interactive prompts,
    reusing config.yml credentials when the URL matches a configured host."""
    targets_by_url: Dict[str, ESTarget] = {}
    defaults: Optional[ESTarget] = None
    try:
        parsed = parse_targets(config) if config else []
        targets_by_url = {t.url: t for t in parsed}
        defaults = parsed[0] if parsed else None
    except Exception:
        pass

    url = normalize_url(prompt_if_missing(args.url, "Elasticsearch URL"))
    matched = targets_by_url.get(url, defaults)

    username = args.username or (matched.username if matched else None)
    password = args.password or (matched.password if matched else None)
    if username and password is None:
        password = getpass.getpass(f"Password for {username}: ")
    if not username and not (matched and matched.api_key):
        username = prompt_if_missing(None, "Username (blank for none)",
                                     default="")
        if username:
            password = getpass.getpass(f"Password for {username}: ")

    index_pattern = (args.index
                     or (matched.index_pattern if matched else None)
                     or prompt_if_missing(None, "Index pattern",
                                          default="logstash-*"))

    return ESTarget(
        name=(matched.name if matched and matched.url == url else "single"),
        url=url,
        username=username or None,
        password=password or None,
        api_key=(matched.api_key if matched and matched.url == url
                 else None),
        index_pattern=index_pattern,
        verify_ssl=matched.verify_ssl if matched else False,
        ca_cert=matched.ca_cert if matched else None,
        request_timeout=matched.request_timeout if matched else 30,
        connect_timeout=matched.connect_timeout if matched else 10,
        max_retries=matched.max_retries if matched else 1,
        retry_delay=matched.retry_delay if matched else 3,
    )


def logtype_fields(settings: Settings) -> List[str]:
    fields = [f for f in settings.metadata_fields
              if f.lower() in LOGTYPE_FIELD_NAMES]
    return fields or ["log_type", "logtag"]


def build_single_query(settings: Settings, device: str,
                       logtype: str, size: int) -> Dict[str, Any]:
    arrival_field = settings.arrival_fields[0]
    if looks_like_ip(device):
        device_fields = ([f for f in settings.metadata_fields
                          if f in IP_LIKE_FIELDS
                          or f.lower().endswith("_ip")] or ["src_ip"])
    else:
        device_fields = [settings.primary_agg_field.replace(".keyword", "")]

    def term_clauses(field_names: Sequence[str],
                     value: str) -> List[Dict[str, Any]]:
        clauses: List[Dict[str, Any]] = []
        for field_name in field_names:
            clauses.append({"term": {field_name: value}})
            keyword = aggregation_field(field_name)
            if keyword != field_name:
                clauses.append({"term": {keyword: value}})
        return clauses

    must: List[Dict[str, Any]] = [
        {"bool": {"should": term_clauses(device_fields, device),
                  "minimum_should_match": 1}},
    ]
    if logtype and logtype.lower() != "all":
        must.append({"bool": {
            "should": term_clauses(logtype_fields(settings), logtype),
            "minimum_should_match": 1}})

    return {
        "size": size,
        "track_total_hits": True,
        "sort": [{arrival_field: {"order": "desc",
                                  "unmapped_type": "date"}}],
        "query": {"bool": {"must": must}},
        "_source": {"includes": query_source_fields(settings)},
    }


def bar(value: float, maximum: float, width: int = 24) -> str:
    if maximum <= 0:
        return ""
    filled = max(0, min(width, round(abs(value) / maximum * width)))
    return "#" * filled + "." * (width - filled)


def column_width(header: str, values: Iterable[Any], pad: int = 2,
                 minimum: int = 0) -> int:
    """Width that fits the header and EVERY value in full - no truncation."""
    longest = max((len(str(v)) for v in values), default=0)
    return max(len(header), longest, minimum) + pad


def render_single_view(target: ESTarget, settings: Settings, device: str,
                       logtype: str, hits: Sequence[Mapping[str, Any]],
                       total_hits: int) -> None:
    term_width = shutil.get_terminal_size((120, 30)).columns
    rule_width = max(60, min(term_width, 200))
    line = "=" * rule_width
    thin_line = "-" * rule_width
    now_utc = datetime.now(timezone.utc)
    warning = settings.delay_threshold_minutes
    critical = settings.critical_threshold_minutes

    print(line)
    print(Color.bold("  ELASTICSEARCH LOG DELAY - REALTIME VIEW"))
    print(line)
    print(f"  ES URL      : {target.url}")
    print(f"  Index       : {target.index_pattern}")
    print(f"  Device      : {device}")
    print(f"  Log type    : {logtype or 'all'}")
    print(f"  Checked at  : "
          f"{datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S %Z')}")
    print(f"  Thresholds  : warning >= {warning} min, "
          f"critical >= {critical} min")
    print(thin_line)

    if not hits:
        print("  " + Color.status("NO_DATA")
              + "  No events found for this device in the index pattern.")
        reasons, fixes = DIAGNOSIS["NO_DATA"]
        print("\n  " + Color.bold("Likely reasons:"))
        for reason in reasons:
            print(f"    - {reason}")
        print("\n  " + Color.bold("Recommended steps:"))
        for fix in fixes:
            print(f"    {fix}")
        print(line)
        return

    rows: List[Tuple[str, str, Optional[float], str, str, str, str]] = []
    delays: List[float] = []
    logtype_candidates = logtype_fields(settings)
    latest_metadata: Dict[str, str] = {}

    for position, hit in enumerate(hits):
        source = hit.get("_source", {})
        arrival_raw = first_available(source, settings.arrival_fields)
        event_raw = first_available(source, settings.event_fields)
        row_logtype = str(first_available(source, logtype_candidates))
        row_zone = str(first_available(source, ["zone"]))
        row_tag1 = str(first_available(source, ["tag1"]))
        if position == 0:
            latest_metadata = {
                name: str(first_available(source, [name]))
                for name in settings.metadata_fields
            }
        delay_minutes: Optional[float] = None
        try:
            arrival_dt = parse_timestamp(arrival_raw)
            event_dt = parse_timestamp(event_raw)
            delay_minutes = round(
                (arrival_dt - event_dt).total_seconds() / 60, 2)
            delays.append(delay_minutes)
        except Exception:
            pass
        status = calculate_status(delay_minutes, warning, critical)
        rows.append((str(event_raw or "?"), str(arrival_raw or "?"),
                     delay_minutes, status, row_logtype, row_zone,
                     row_tag1))

    # Device metadata block - built dynamically from metadata_fields.
    # zone and tag1 are ALWAYS shown, even when empty.
    always_show = ("zone", "tag1")
    populated = {k: v for k, v in latest_metadata.items()
                 if v or k in always_show}
    for name in always_show:
        populated.setdefault(name, "")
    if populated:
        print(Color.bold("  Device details (latest event):"))
        label_width = max(len(name) for name in populated)
        for name, value in populated.items():
            print(f"    {name:<{label_width}} : {value or '-'}")
        print(thin_line)

    (latest_event_raw, latest_arrival_raw, latest_delay, latest_status,
     latest_logtype, _, _) = rows[0]

    freshness_minutes: Optional[float] = None
    try:
        freshness_minutes = round(
            (now_utc - parse_timestamp(latest_arrival_raw)
             ).total_seconds() / 60, 2)
    except Exception:
        pass

    print(f"  Matching events in index : {total_hits}")
    print(f"  Latest event time        : {latest_event_raw}")
    print(f"  Latest arrival time      : {latest_arrival_raw}")
    if freshness_minutes is not None:
        freshness_status = ("OK" if freshness_minutes < warning else
                            "DELAYED" if freshness_minutes < critical
                            else "CRITICAL")
        print(f"  Last log received        : {freshness_minutes} min ago "
              f"[{Color.status(freshness_status)}]")
    print("  Latest pipeline delay    : "
          + Color.bold(f"{latest_delay if latest_delay is not None else 'N/A'}"
                       f" min")
          + f"  [{Color.status(latest_status)}]")

    if delays:
        print(thin_line)
        print(f"  Statistics over last {len(delays)} events (minutes): "
              f"min={round(min(delays), 2)}  avg={round(mean(delays), 2)}  "
              f"median={round(median(delays), 2)}  "
              f"max={round(max(delays), 2)}")

    # Per-logtype breakdown (rows are newest-first, so first row per
    # log_type is its latest event). Detects the zone-mismatch scenario.
    by_type: Dict[str, Tuple[str, str, Optional[float], str, str, str,
                             str]] = {}
    for row in rows:
        by_type.setdefault(row[4] or "?", row)
    ok_types = sorted(t for t, row in by_type.items() if row[3] == "OK")
    bad_types = sorted(t for t, row in by_type.items()
                       if row[3] in {"DELAYED", "CRITICAL"})
    if len(by_type) > 1:
        print(thin_line)
        print(Color.bold("  Per log_type (latest event each):"))
        type_width = max(len(t) for t in by_type)
        zone_width = max((len(row[5] or "-") for row in by_type.values()),
                         default=1)
        for log_type_name, row in sorted(by_type.items()):
            delay_text = "N/A" if row[2] is None else f"{row[2]}"
            status_text = (Color.status(row[3])
                           + " " * max(0, 12 - len(row[3])))
            print(f"    {log_type_name:<{type_width}}  "
                  f"delay={delay_text:>9} min  {status_text}"
                  f"zone={(row[5] or '-'):<{zone_width}}  "
                  f"tag1={row[6] or '-'}")

    # Sort events by EVENT TIME ascending (A-Z / oldest first).
    display_rows = sorted(rows, key=lambda r: r[0])

    delay_texts = ["N/A" if r[2] is None else f"{r[2]}"
                   for r in display_rows]
    width_event = column_width("EVENT TIME", (r[0] for r in display_rows))
    width_arrival = column_width("ARRIVAL TIME",
                                 (r[1] for r in display_rows))
    width_delay = column_width("DELAY(min)", delay_texts)
    width_status = column_width("STATUS", (r[3] for r in display_rows))
    width_logtype = column_width("LOG TYPE",
                                 (r[4] or "-" for r in display_rows))
    width_zone = column_width("ZONE", (r[5] or "-" for r in display_rows))
    width_tag1 = column_width("TAG1", (r[6] or "-" for r in display_rows))

    print(thin_line)
    print(Color.bold(
        f"  {'EVENT TIME':<{width_event}}{'ARRIVAL TIME':<{width_arrival}}"
        f"{'DELAY(min)':>{width_delay}}  {'STATUS':<{width_status}}"
        f"{'LOG TYPE':<{width_logtype}}{'ZONE':<{width_zone}}"
        f"{'TAG1':<{width_tag1}}GRAPH"))
    maximum = max((abs(d) for d in delays), default=0)
    for (event_raw, arrival_raw, delay_minutes, status, row_logtype,
         row_zone, row_tag1) in display_rows:
        delay_text = "N/A" if delay_minutes is None else f"{delay_minutes}"
        # Colour codes add invisible characters - pad the plain text first.
        status_text = (Color.status(status)
                       + " " * max(0, width_status - len(status)))
        print(f"  {event_raw:<{width_event}}{arrival_raw:<{width_arrival}}"
              f"{delay_text:>{width_delay}}  {status_text}"
              f"{(row_logtype or '-'):<{width_logtype}}"
              f"{(row_zone or '-'):<{width_zone}}"
              f"{(row_tag1 or '-'):<{width_tag1}}"
              f"{bar(delay_minutes or 0, maximum)}")

    # Exact pattern diagnosis for the verdict.
    verdict = DelayRecord(
        es_name=target.name, es_url=target.url, index="",
        device=device, report_date="", arrival_time=latest_arrival_raw,
        event_time=latest_event_raw, delay_minutes=latest_delay,
        delay_status=latest_status, log_type=latest_logtype,
        metadata=latest_metadata)
    analyze_pattern(verdict, delays, settings)
    if (ok_types and bad_types
            and verdict.pattern not in {"OLD_LOGS", "TZ_OFFSET"}):
        ok_zones = sorted({by_type[t][5] or "?" for t in ok_types})
        bad_zones = sorted({by_type[t][5] or "?" for t in bad_types})
        verdict.pattern = "LOGTYPE_ZONE"
        verdict.reason = (
            f"log_type {', '.join(bad_types)} delayed while"
            f" {', '.join(ok_types)} from the SAME device is on time -"
            f" zone mismatch: delayed zone={', '.join(bad_zones)} vs OK"
            f" zone={', '.join(ok_zones)} (or one zone filter applied to"
            " all log types)")
        verdict.fix = (
            "Check the zone value on the delayed log_type and correct it"
            " in that log_type's parser filter - do not reuse one zone"
            " filter for every log type")
        if latest_status == "OK":
            latest_status = by_type[bad_types[0]][3]

    print(thin_line)
    print("  " + Color.bold("VERDICT: ") + Color.status(latest_status)
          + f"  [pattern: {verdict.pattern}]")
    print(f"  Exact reason : {verdict.reason}")
    if latest_status != "OK" or verdict.pattern not in {"-", "GENERIC"}:
        print("  " + Color.bold("Exact fix    : ") + verdict.fix)
        if verdict.pattern in {"GENERIC", "PARSE_ERROR"}:
            reasons, fixes = DIAGNOSIS.get(latest_status, ([], []))
            print("\n  " + Color.bold("Checklist:"))
            for fix_step in fixes:
                print(f"    {fix_step}")
    print(line)


def run_single_mode(args: argparse.Namespace,
                    config: Mapping[str, Any]) -> int:
    settings = parse_settings(config)
    target = single_target_from_args(args, config)
    device = prompt_if_missing(args.device,
                               "Device (src_ip or src_hostname)")
    logtype = args.logtype or prompt_if_missing(
        None, 'Log type ("all" or a specific value)', default="all")

    es = create_es_client(target)
    test_connection(es, target)

    def run_once() -> None:
        body = build_single_query(settings, device, logtype, args.events)
        response = execute_search_with_retry(
            es, target, target.index_pattern, body)
        hits = response.get("hits", {}).get("hits", [])
        total = response.get("hits", {}).get("total", {})
        total_hits = (total.get("value", 0)
                      if isinstance(total, Mapping) else int(total or 0))
        render_single_view(target, settings, device, logtype, hits,
                           total_hits)

    if args.watch:
        try:
            while True:
                if Color.enabled:
                    print("\033[2J\033[H", end="")
                run_once()
                print(f"  Refreshing every {args.watch}s. "
                      "Press Ctrl+C to stop.")
                time_module.sleep(args.watch)
        except KeyboardInterrupt:
            print("\nStopped.")
            return 0
    else:
        run_once()
    return 0


# ---------------------------------------------------------------------------
# Report mode
# ---------------------------------------------------------------------------
def run_report_mode(args: argparse.Namespace,
                    config: Mapping[str, Any]) -> int:
    settings = parse_settings(config)
    targets = parse_targets(config)
    time_selection = determine_time_selection(config, args.time_selection)

    output_config = config.get("output", {})
    if not isinstance(output_config, Mapping):
        output_config = {}
    output_directory = Path(str(output_config.get(
        "directory", "./output_stats")))
    output_directory.mkdir(parents=True, exist_ok=True)
    retention_days = int(output_config.get("retention_days", 30))

    all_records: List[DelayRecord] = []
    all_selected_days: List[date] = []
    failed_targets: List[str] = []

    for target in targets:
        try:
            records, selected_days = collect_target_records(
                target, settings, time_selection)
            all_records.extend(records)
            all_selected_days.extend(selected_days)
        except Exception as exc:
            failed_targets.append(target.name)
            LOGGER.exception("[%s] Collection failed: %s", target.name, exc)

    if not all_records and failed_targets:
        LOGGER.error("All Elasticsearch targets failed. No report created.")
        return 1

    selected_days = sorted(set(all_selected_days))
    timestamp = datetime.now().strftime("%Y_%m_%d_%H_%M_%S")
    safe_time = re.sub(r"[^A-Za-z0-9_.-]+", "_", time_selection)
    prefix = str(output_config.get("filename_prefix", "log_delay"))
    xlsx_path = output_directory / f"{prefix}_{safe_time}_{timestamp}.xlsx"

    build_xlsx_report(xlsx_path, all_records, selected_days, targets,
                      settings, time_selection,
                      latest_status_column_config(config))
    LOGGER.info("Report created: %s", xlsx_path)

    try:
        forward_to_output_es(config, all_records, time_selection)
    except Exception as exc:
        LOGGER.exception("Forwarding to output Elasticsearch failed: %s",
                         exc)

    email_config = config.get("email", {})
    if not isinstance(email_config, Mapping):
        email_config = {}
    email_enabled = bool(email_config.get("enabled", False))
    only_on_delay = bool(email_config.get("only_on_delay", False)
                         or args.email_only_on_delay)

    if (email_enabled and not args.no_email
            and (not only_on_delay or has_problems(all_records))):
        try:
            send_email(email_config, all_records, settings, targets,
                       [xlsx_path], time_selection)
        except Exception as exc:
            LOGGER.exception("Email sending failed: %s", exc)
            return 4
    elif email_enabled and only_on_delay:
        LOGGER.info("No delayed devices found. Email was not sent.")

    clean_old_reports(output_directory, retention_days)

    if failed_targets:
        LOGGER.warning("Completed with failed targets: %s",
                       ", ".join(failed_targets))
        return 3
    return 0


def main() -> int:
    args = parse_arguments()
    try:
        config: Dict[str, Any] = {}
        if args.config:
            config = read_yaml(Path(args.config))
        elif not args.single:
            raise ValueError("--config is required for report mode.")

        configure_logging(config, args.log_level)

        if args.single:
            return run_single_mode(args, config)
        return run_report_mode(args, config)

    except KeyboardInterrupt:
        print("\nInterrupted.")
        return 130
    except (ValueError, OSError, KeyError) as exc:
        logging.basicConfig(level=logging.ERROR,
                            format="%(asctime)s %(levelname)s %(message)s")
        LOGGER.error("%s", exc)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())