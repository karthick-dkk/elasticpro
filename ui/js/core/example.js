export const EXAMPLE_YAML = `# ---------------------------------------------------------------------------
# ElasticPro - cluster configuration
#
# This file is the ONLY place your credentials live. The app reads it from disk
# into memory on every start; it never copies it anywhere else.
# Keep it readable only by you (NTFS permissions / chmod 600).
# ---------------------------------------------------------------------------
version: 1

# One credential used for EVERY cluster below (per-cluster overrides are optional).
#
# You can also LEAVE THIS BLOCK OUT (or give only a username). The dashboard then asks
# for the credential once when it loads and applies it to every cluster URL in one click.
# Nothing is written back to this file.
credentials:
  username: elastic
  password: "change-me"
  # ...or use an API key instead of username/password:
  # apiKey: "id:api_key"        # raw pair, or an already base64-encoded value
  # ...or a bearer token:
  # bearer: "eyJhbGci..."

defaults:
  # Safety switch. true (the default) means the extension only ever sends GET/HEAD plus
  # search-family POSTs (_search, _count, _field_caps ...). Every PUT/DELETE and every
  # other POST is refused inside the extension's service worker, before a socket opens,
  # so nothing can modify your clusters. Set to false only if you want the REST console
  # and the SLM "Run now" button to be able to write.
  readOnly: true

  # Auto-refresh is OFF by default - the dashboard loads once and then stays put.
  # Turn it on here, or with the "Auto" toggle in the top bar (your choice is remembered).
  autoRefresh: false
  refreshIntervalSec: 30        # how often, when auto-refresh is on
  requestTimeoutMs: 15000
  diskWarnPercent: 80
  diskCritPercent: 90
  snapshotStaleHours: 26        # alert if no successful SLM snapshot within this window
  maxLogRows: 200

  # Daily log indices, e.g. logstash-acme-2026.01.02
  logIndexPattern: "logstash-*"
  timeField: "@timestamp"
  # Named groups <source> and <date> drive the source picker on the Indices page.
  # A source is the tenant inside an index name — a whole cluster is a client.
  # <client> is still accepted here, for configs written before the rename.
  indexNameRegex: '^(?<prefix>[a-z0-9_.-]*?logstash)(?:-(?<source>.+))?-(?<date>\\d{4}[.\\-]\\d{2}[.\\-]\\d{2})$'

# Jump hosts. A cluster with \`via: <name>\` is reached through an SSH connection the app
# opens itself (no ssh.exe, no PuTTY): the same thing \`ssh -D\` does. Key file only —
# a passphrase (if the key has one) is asked for in the app and kept in memory.
# The host key is shown and confirmed on first contact, then pinned.
jump_hosts:
  jumpwin:
    host: jump-windows.internal
    port: 22
    user: jump-user
    keyFile: C:\\Users\\me\\.ssh\\id_ed25519      # OpenSSH format (PuTTY .ppk: export it first)
  jumpubuntu:
    host: jump-ubuntu.internal
    user: jump-user
    keyFile: C:\\Users\\me\\.ssh\\id_ed25519

clusters:
  # reached through the Windows jump host — the name is resolved ON the jump host
  - name: acme-onprem
    url: https://203.0.113.50:9200
    # Capacity planning, used by the Volume report page. Accepts 30d, 90 days, 3M,
    # 6 months, 1y or a bare number of days. Omit them and the report says "not set"
    # rather than assuming a number.
    liveRetention: 30d
    snapshotRetention: 6M
    via: jumpwin
    tags: [onprem, acme]

  - name: prod-elk
    url: https://es-prod-01.internal:9200
    tags: [prod, primary]

  - name: dr-elk
    url: https://es-dr-01.internal:9200
    tags: [dr]

  - name: lab
    url: http://192.168.10.25:9200
    enabled: true
    # tls: auto (default) = OS trust store, else ask once and pin the certificate
    #      system          = OS trust store only (strict)
    #      insecure        = accept anything (lab only)
    # tls: auto
    # per-cluster credential override (optional):
    # username: lab_reader
    # password: "another-secret"
    # per-cluster index naming override (optional):
    # logIndexPattern: "filebeat-*"
    # indexNameRegex: '^(?<prefix>filebeat)-(?<source>.+)-(?<date>\\d{4}\\.\\d{2}\\.\\d{2})$'
`;
