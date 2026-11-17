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
- `defaults.tls: insecure` (Config → Defaults → Certificates) turns off certificate and host-key
  checking for every cluster, jump host and the Zabbix API at once. With it on, an interception
  would not be noticed. It is off by default, only an admin who can edit the config changes it
  on the hosted build, and what it lets through is listed in the app.
  Passphrases are asked for and kept in memory only.
- Listens only on 127.0.0.1 (the in-process SOCKS5 proxy for tunnelled clusters).
- Writes: `pins.json` (fingerprints), `config_cluster.json`, the WebView profile. The write
  unlock is never among them.

**Not covered.** The desktop builds ended with 0.3.51 and their Windows binaries were never
code-signed. Releases from 0.3.52 carry the Docker images and the Zabbix modules archive; verify
the archive against `SHA256SUMS.txt` from the release.

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

**Container images.** The hosted deployment is built to carry **no known vulnerabilities**.
Every image was scanned with Trivy on 2026-10-07, at every severity, against a cold cache:

| image | CRITICAL+HIGH | how |
| --- | --- | --- |
| `elasticpro-core` | **0** (and zero at LOW and MEDIUM too) | Alpine + a musl build |
| `elasticpro-nginx` | **0** | `nginx:1.30-alpine` + `apk upgrade` |
| `redis:8-alpine` | **0** | upstream, unmodified |

Reproduce any of them with:

```
trivy image --scanners vuln --severity LOW,MEDIUM,HIGH,CRITICAL <image>
```

Three things are worth knowing about how that zero was reached, because each was a real
obstacle rather than a tag bump:

*The core runs on Alpine and musl, not Debian.* The Debian runtime it replaced scanned at
one CRITICAL and sixty-one HIGH **after** `apt-get upgrade` — advisories Debian has published
no fix for, which no care in the Dockerfile removes. `alpine:3.22` scans clean, and because
the crypto is `ring` throughout (both rustls and russh select it) there is no OpenSSL to link
and the musl build is a recompile rather than a port. The image also fell from 191 MB to
29.5 MB. `curl` is deliberately absent — it would pull libcurl and OpenSSL back in, which is
most of the surface this base exists to avoid — so the healthcheck posts its probe with
busybox `wget`, which supports `--header` and `--post-data`.

*There is no database image any more.* The stack used to carry `elasticpro-postgres`
(`postgres:16-alpine` with `gosu` swapped for `su-exec` and the result flattened, which is
what it took to scan clean). Nothing in ElasticPro ever connected to it — accounts are files
in the data directory and shared state is in Redis — so it was taken out of the stack and is
no longer published, which removes that image and its maintenance from the surface altogether.

*nginx and Redis are thin layers over the official images*, built from `deploy/images/` and
published by CI rather than built on the host. Both exist only because upstream rebuilds lag
the fixes their own distributions have already published. If upstream starts scanning clean
on its own, delete `deploy/images/` and go back to the plain tags.

`deploy/vault/` is optional and pins `hashicorp/vault:2.1`; 1.18 reported four CRITICAL and
eighty HIGH. Upgrading a Vault that already holds data is a major-version migration, not a tag
swap — snapshot first and follow HashiCorp's guide. `node:22-alpine`, used only by the optional
scraper and plan jobs, reports HIGH findings in the dependencies npm bundles; the container
runs `node <script>.mjs` and never invokes npm, and 24-alpine eliminates none of them.
