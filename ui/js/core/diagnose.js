/**
 * Connection diagnostics.
 *
 * A failed HTTPS fetch from a browser is deliberately opaque — Chrome reports the same
 * "Failed to fetch" for an untrusted certificate, a closed port, a wrong scheme and a dead
 * host. Rather than guess in the error message, probe the opposite scheme on the same
 * host:port. If that answers at all, the TCP port is open and the problem is TLS; if it
 * does not, the problem is reachability.
 */

import { probeUrl } from './es.js';

function altScheme(url) {
  try {
    const u = new URL(url);
    u.protocol = u.protocol === 'https:' ? 'http:' : 'https:';
    return u.origin + u.pathname.replace(/\/$/, '');
  } catch { return null; }
}

function looksLikeEs(res) {
  const j = res.json;
  if (j && (j.cluster_name || j.tagline || (j.version && j.version.number))) return true;
  if (j && j.error && (j.error.type === 'security_exception' || j.status === 401)) return true;
  if (res.status === 401 || res.status === 403) return true;
  return false;
}

/** @returns {{steps: Array, verdict: string, title: string, detail: string, fix: string, fixUrl?: string}} */
export async function diagnoseCluster(cluster) {
  const steps = [];
  const configured = cluster.url;
  const isHttps = /^https:/i.test(configured);
  const alt = altScheme(configured);

  const a = await probeUrl(cluster.id, configured);
  steps.push({
    label: `GET ${configured}/`,
    ok: a.ok || a.status > 0,
    detail: `${a.status ? `HTTP ${a.status}` : a.netError ? a.netError : a.kind === 'timeout' ? 'timed out' : 'no response'} · ${a.tookMs} ms`,
  });

  // If Chrome gave us the real network error, that settles it outright - no probing needed.
  if (a.netError) {
    return {
      steps, verdict: /CERT/.test(a.netError) ? 'tls' : 'unreachable',
      netError: a.netError,
      title: a.netError,
      detail: a.netErrorHelp || 'Chrome reported this error for the connection.',
      fix: a.netError === 'net::ERR_CERT_COMMON_NAME_INVALID'
        ? `The address must appear in the certificate's SAN. Check it with:\n  openssl s_client -connect ${hostPort(configured)} </dev/null 2>/dev/null | openssl x509 -noout -ext subjectAltName\nThen reissue with that name/IP, or point clusters.yaml at a name the certificate already covers.`
        : /CERT/.test(a.netError)
          ? 'Install the CA — Windows Trusted Root store, or Chrome\u2019s CACertificates policy. Clicking through the warning in a tab is NOT enough: that exception does not apply to the extension\u2019s requests. Then fully quit and reopen Chrome.'
          : 'This is below TLS — fix connectivity first.',
      fixUrl: /CERT/.test(a.netError) ? configured + '/' : undefined,
    };
  }

  // Reachable at the HTTP layer — nothing to diagnose about the transport.
  if (a.ok) {
    return { steps, verdict: 'ok', title: 'Connected', detail: 'The cluster answered normally.', fix: '' };
  }
  if (a.status === 401 || a.status === 403) {
    return {
      steps, verdict: 'auth',
      title: 'Reachable — credentials rejected',
      detail: `TLS and networking are fine; Elasticsearch returned HTTP ${a.status}.`,
      fix: 'Use the Sign in button to enter a working credential.',
    };
  }
  if (a.status > 0) {
    return {
      steps, verdict: 'http_error',
      title: `Reachable — HTTP ${a.status}`,
      detail: a.message || 'The endpoint answered with an error status.',
      fix: 'The transport is fine. Check the path and the cluster’s own logs.',
    };
  }

  // Transport failed. Ask the same host:port on the other scheme.
  let b = null;
  if (alt) {
    b = await probeUrl(cluster.id, alt, 6000);
    steps.push({
      label: `GET ${alt}/  (probe: does the port answer on the other scheme?)`,
      ok: b.status > 0,
      detail: `${b.status ? `HTTP ${b.status}` : b.kind === 'timeout' ? 'timed out' : 'no response'} · ${b.tookMs} ms`,
    });
  }

  if (b && b.status > 0) {
    // The port is open and speaking the other protocol.
    if (isHttps && looksLikeEs(b)) {
      return {
        steps, verdict: 'wrong_scheme',
        title: 'This endpoint speaks plain HTTP, not HTTPS',
        detail: `${alt}/ returned a valid Elasticsearch response (HTTP ${b.status}), while the configured https:// URL cannot complete a TLS handshake.`,
        fix: `Change the URL for "${cluster.name}" in clusters.yaml to ${alt} and reload the config.`,
      };
    }
    if (isHttps) {
      return {
        steps, verdict: 'tls',
        title: 'Port is open — the certificate is the problem',
        detail: `The host and port are reachable (${alt}/ answered HTTP ${b.status}), so this is not DNS, a firewall or a down node. The HTTPS request is failing during the TLS handshake, which for an internal cluster almost always means an untrusted or self-signed certificate.`,
        fix: 'Install the CA: Windows Trusted Root store, or Chrome\u2019s CACertificates policy. Accepting the warning in a browser tab will NOT fix this — that exception does not apply to the extension\u2019s own requests (verified). Then fully quit and reopen Chrome.',
        fixUrl: configured + '/',
      };
    }
    return {
      steps, verdict: 'needs_tls',
      title: 'This endpoint requires TLS',
      detail: `${alt}/ answered HTTP ${b.status} while the configured http:// URL did not.`,
      fix: `Change the URL for "${cluster.name}" in clusters.yaml to ${alt}.`,
    };
  }

  // Both schemes failed. A browser cannot tell these two apart from JavaScript: Chrome
  // reports the identical opaque failure for "certificate not trusted" and "nothing is
  // listening". And a plaintext probe against a TLS-enabled Elasticsearch port is closed
  // by the server, so this outcome is exactly what a genuine certificate problem looks
  // like. Say so, and hand over the two commands that settle it.
  const fast = a.tookMs < 1500 && (!b || b.tookMs < 1500);
  return {
    steps, verdict: 'ambiguous',
    title: isHttps ? 'Either an untrusted certificate, or nothing listening' : 'No response on either scheme',
    detail: isHttps
      ? 'Neither probe got a response. From inside a browser these two cases are indistinguishable: ' +
        'an untrusted certificate and a closed/filtered port both surface as the same opaque error. ' +
        'A plaintext probe against a TLS-enabled Elasticsearch port is also closed by the server, ' +
        'so this result is consistent with a certificate problem — it does not rule one in or out. ' +
        (fast ? 'Both probes failed quickly, which leans towards a refused connection or a rejected certificate rather than a firewall drop.'
              : 'The probes were slow to fail, which leans towards a firewall dropping packets rather than a refused connection.')
      : `Neither ${configured}/ nor ${alt}/ answered, so the failure is below HTTP: wrong host or port, DNS, a firewall, or the node being down.`,
    fix: isHttps
      ? 'Accepting the certificate in a tab will not help here — that exception does not cover the extension. Settle what the failure actually is from a shell on this machine:\n' +
        `  curl -vk ${configured}/          → TLS handshake completes = the port is fine, it is the certificate\n` +
        `  openssl s_client -connect ${hostPort(configured)}   → shows the presented chain\n` +
        'If it is the certificate, install the CA — Windows Trusted Root store, or Chrome\u2019s CACertificates policy — then fully quit and reopen Chrome.'
      : `Check the address, then from this machine: curl -v ${configured}/`,
    fixUrl: isHttps ? configured + '/' : undefined,
  };
}

/**
 * Which Chromium-family browser is this? Brave and Edge honour the same policies as
 * Chrome but read them from their own registry key / policy directory, so the commands
 * we print have to match.
 */
export async function detectBrowser() {
  try {
    if (navigator.brave && typeof navigator.brave.isBrave === 'function' && (await navigator.brave.isBrave())) {
      return { id: 'brave', name: 'Brave',
        winKey: 'HKCU:\\SOFTWARE\\Policies\\BraveSoftware\\Brave\\CACertificates',
        linuxDir: '/etc/brave/policies/managed', scheme: 'brave' };
    }
  } catch (_) { /* not Brave */ }
  if (/Edg\//.test(navigator.userAgent)) {
    return { id: 'edge', name: 'Edge',
      winKey: 'HKCU:\\SOFTWARE\\Policies\\Microsoft\\Edge\\CACertificates',
      linuxDir: '/etc/opt/edge/policies/managed', scheme: 'edge' };
  }
  return { id: 'chrome', name: 'Chrome',
    winKey: 'HKCU:\\SOFTWARE\\Policies\\Google\\Chrome\\CACertificates',
    linuxDir: '/etc/opt/chrome/policies/managed', scheme: 'chrome' };
}

/** Platform-specific commands for making the certificate trusted for good. */
export function trustHint(url, browser) {
  const b = browser || { id: 'chrome', name: 'Chrome',
    winKey: 'HKCU:\\SOFTWARE\\Policies\\Google\\Chrome\\CACertificates',
    linuxDir: '/etc/opt/chrome/policies/managed', scheme: 'chrome' };
  const hp = hostPort(url);
  const ua = navigator.userAgent;
  const isWin = /Windows/i.test(ua);
  const isMac = /Mac OS X|Macintosh/i.test(ua);
  if (isWin) {
    return {
      os: 'Windows',
      note: `Two routes for ${b.name}. Policy alone (HKCU, no admin, Windows store untouched) needs a Chromium 132+ base — check ${b.scheme}://version. Otherwise import into the Windows Trusted Root store, which ${b.name} also reads and which fixes curl/PowerShell/Java on that box too.`,
      lines: [
        '# 1. save the CA the server presents (PowerShell)',
        `$c = [Net.Sockets.TcpClient]::new("${hp.split(':')[0]}", ${hp.split(':')[1]})`,
        '$s = [Net.Security.SslStream]::new($c.GetStream(), $false, {$true})',
        `$s.AuthenticateAsClient("${hp.split(':')[0]}")`,
        '$leaf = [Security.Cryptography.X509Certificates.X509Certificate2]::new($s.RemoteCertificate)',
        '$ch = [Security.Cryptography.X509Certificates.X509Chain]::new(); $ch.Build($leaf) | Out-Null',
        '$root = $ch.ChainElements[$ch.ChainElements.Count-1].Certificate',
        '[IO.File]::WriteAllBytes("$PWD\\es-ca.cer", $root.Export("Cert")); $root.Thumbprint',
        '',
        `# 2a. compare that thumbprint with the node, then EITHER \u2014 no admin, ${b.name} only:`,
        '$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\\es-ca.cer"))',
        `$k = "${b.winKey}"`,
        'New-Item $k -Force | Out-Null',
        'New-ItemProperty $k -Name 1 -Value $b64 -PropertyType String -Force | Out-Null',
        '',
        '# 2b. ...OR machine-wide (elevated) \u2014 also fixes curl / PowerShell / Java:',
        'Import-Certificate -FilePath .\\es-ca.cer -CertStoreLocation Cert:\\LocalMachine\\Root',
        '',
        `# 3. fully quit ${b.name} (check Task Manager), reopen, verify at ${b.scheme}://policy, press Recheck`,
      ],
    };
  }
  if (isMac) {
    return {
      os: 'macOS',
      note: `${b.name} on macOS honours the trust setting in the system keychain.`,
      lines: [
        `openssl s_client -showcerts -connect ${hp} </dev/null 2>/dev/null | openssl x509 -out es-ca.crt`,
        'openssl x509 -in es-ca.crt -noout -fingerprint -sha256   # compare with the node',
        'sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain es-ca.crt',
        `# then quit ${b.name} entirely (Cmd-Q) and reopen`,
      ],
    };
  }
  return {
    os: 'Linux',
    note: `${b.name} on Linux does not use the system trust store for user-added roots — it keeps them in a per-user NSS database, so both steps are needed. Alternatively drop a policy file in ${b.linuxDir}/.`,
    lines: [
      `openssl s_client -showcerts -connect ${hp} </dev/null 2>/dev/null | openssl x509 -out es-ca.crt`,
      'sudo cp es-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates',
      'certutil -d sql:$HOME/.local/share/pki/nssdb -A -t "C,," -n "Internal ES CA" -i es-ca.crt',
      `# then quit ${b.name} entirely and reopen`,
    ],
  };
}

function hostPort(url) {
  try { const u = new URL(url); return `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`; }
  catch { return url; }
}
