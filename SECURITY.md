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
