# Security

**Reporting.** Open a private security advisory on GitHub or e-mail the maintainer; please do
not file public issues for vulnerabilities.

**What the app does and does not do**

- Sends only `GET`/`HEAD` and search-family `POST` requests to Elasticsearch while `readOnly`
  is true (the default). The check is in the Rust core, before a socket is opened.
- Lets a write out in exactly two cases, both requiring a deliberate act:
  - `readOnly: false` in the config file — writes are allowed everywhere.
  - An action the operator took in the UI after ticking *Allow writes*: a request typed in
    the REST console, a snapshot created or deleted, an index opened, closed or removed.
    That unlock lives in the core's memory for the session (never on disk, gone on
    restart), and it is not sufficient by itself — the request must also be marked as one
    the operator asked for. A background refresh, a page load or any future code path
    still cannot write while the session is unlocked.
- Never writes a credential in plain text. Credentials typed in the UI are held in memory;
  when saved to `config_cluster.json` they are encrypted with AES-256-GCM under a key derived
  from a master password (PBKDF2-HMAC-SHA512, 600 000 rounds, random salt and nonce).
  Optionally the credential is stored in the OS vault (Windows Credential Manager).
- Verifies TLS against the OS trust store; a certificate the OS does not trust is shown to the
  operator once and pinned (SHA-256) on explicit consent. A changed certificate is refused.
- Opens SSH connections with the operator's key file; host keys are confirmed once and pinned.
  Passphrases are asked for and kept in memory only.
- Listens only on 127.0.0.1 (the in-process SOCKS5 proxy for tunnelled clusters).
- Writes: `pins.json` (fingerprints), `config_cluster.json`, the WebView profile. The write
  unlock is never among them.

**Not covered.** The Windows binaries are not code-signed. Verify `SHA256SUMS.txt` from the
release, or build from source.

**Known advisories in dependencies.** CI runs `cargo audit` on every push. One advisory is
currently accepted rather than fixed, because there is no fixed version to move to:

| Advisory | Crate | Why it is still here |
|---|---|---|
| [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071) — "Marvin Attack", a timing sidechannel that can leak an RSA private key to an attacker who can measure many private-key operations precisely | `rsa`, via `russh`'s `rsa` feature | No patched release exists ([RustCrypto/RSA#626](https://github.com/RustCrypto/RSA/issues/626) is open). The feature is what lets the app authenticate to a jump host with an `id_rsa` key; removing it would drop RSA jump-host support. Revisit when a fix ships. |

`cargo audit` also reports unmaintained crates (`serde_yaml`, `proc-macro-error`, the `unic-*`
family) and an unsoundness in `glib` — the latter reached only through the Linux GTK build, not
the Windows one. These are warnings, not vulnerabilities. The accepted advisory is listed in
[`.cargo/audit.toml`](.cargo/audit.toml) with the same reasoning, so nothing is suppressed
silently.

**Container images.** The hosted deployment runs four images besides the core. They were
scanned with Trivy (`--severity CRITICAL,HIGH`) on 2026-10-07 and pinned to what that scan
found clean:

| image | why this pin |
|---|---|
| `nginx:1.30-alpine` | 1.27-alpine carried two CRITICAL OpenSSL advisories (CVE-2026-31789) and four HIGH. 1.30 is the current stable line: 0 CRITICAL. |
| `redis:8-alpine` | 7-alpine carried four HIGH OpenSSL advisories; 8-alpine scans clean. The cache uses only `GET`, `SET … EX`, `DEL`, `SCAN` and `PUBLISH`, which are unchanged across the major. |
| `postgres:16-alpine` | **Deliberately not upgraded.** 16, 17 and 18-alpine all report the same one CRITICAL and 21 HIGH, every one of them in the Go standard library inside the bundled `gosu` helper rather than in PostgreSQL. `gosu` runs once at container start to drop root and never touches network input, and moving a major would mean a dump and restore for no reduction in findings. PostgreSQL itself is 16.15, the current patch of a supported line. |
| `node:22-alpine` | Used only by the optional scraper and plan jobs. Its HIGH findings are all in the dependencies npm bundles (`brace-expansion`, `tar`, `undici`, `ip-address`); the container runs `node <script>.mjs` and never invokes npm, so they are not reachable. 24-alpine reports eight rather than eleven and eliminates none of them, so the LTS line is kept. |

The core image's own base is `debian:bookworm-slim`, which is rebuilt only periodically and
so lags the Debian archive. `deploy/Dockerfile` runs `apt-get upgrade` before installing, which
is what clears it — without that line the published image carried four CRITICAL and three HIGH
advisories against `perl-base` alone.

`deploy/vault/` is optional and pins `hashicorp/vault:2.1`; 1.18 reported four CRITICAL and
eighty HIGH. Upgrading a Vault that already holds data is a major-version migration, not a tag
swap — snapshot first and follow HashiCorp's guide.

**What the core image scans at.** After the `apt-get upgrade` above, `elasticpro-core:0.1.0`
reports **nothing with a fix available** — the fixable count is zero. What remains is one
CRITICAL and sixty-one HIGH advisories that Debian has not shipped patches for, which is the
ordinary state of any Debian-based image. The CRITICAL is
[CVE-2023-45853](https://nvd.nist.gov/vuln/detail/CVE-2023-45853) in `zlib1g`, marked
`will_not_fix` by Debian: the overflow is in MiniZip, a contrib utility in the zlib source
tree that Debian's `zlib1g` does not build or ship, so the vulnerable function is not in the
library. For comparison, the last release of the previous name scanned at four CRITICAL and
sixty-six HIGH with eight of them fixable.

Re-run the check yourself with:

```
trivy image --scanners vuln --severity CRITICAL,HIGH karthickdk02/elasticpro-core:0.1.0
```
