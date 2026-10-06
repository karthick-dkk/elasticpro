ElasticPro 0.1.0 - portable build for Windows x64
=================================================

Nothing to install, no admin rights, nothing written outside this folder.

Folder layout
  elasticpro-<ver>.exe     the app (the version is in the file name)
  WebView2Loader.dll       keep next to the exe
  SHA256SUMS.txt           checksums for the exe and the loader - the binaries are unsigned,
                           so this is how you tell this zip is the one that was published
  portable                 marker file: keeps all app data in .\data\ (delete it to use %APPDATA% instead)
  data\                    created on first run: config_cluster.json, pins.json (trusted certs /
                           host keys), the WebView profile
  WebView2Runtime\         see below - the only piece Microsoft does not let us ship in this zip
  clusters.example.yaml    an example to start from if you would rather hand-write the config

WebView2Runtime (one-time, no install)
  The app renders its UI with Microsoft WebView2. Windows 10/11 and Server 2019+ already have
  it system-wide and this folder can stay empty. Windows Server 2016 does not, and installing
  the "Evergreen" runtime needs admin - so use Microsoft's FIXED VERSION runtime instead, which
  is just a folder you unpack:
    1. https://developer.microsoft.com/microsoft-edge/webview2/  ->  "Fixed Version"  ->  x64
       (a ~180 MB .cab file, e.g. Microsoft.WebView2.FixedVersionRuntime.140.0.3485.54.x64.cab)
    2. In this folder:   expand Microsoft.WebView2.FixedVersionRuntime.*.x64.cab -F:* WebView2Runtime
       (or 7-Zip -> extract into WebView2Runtime). Result: WebView2Runtime\Microsoft.WebView2...\msedgewebview2.exe
    3. Done. The app finds msedgewebview2.exe there (one level of nesting is fine) and never
       touches the system. ~500 MB on disk; the same folder can be copied to every machine.

Run
  Double-click elasticpro.exe. It is not code-signed: if SmartScreen says
  "Windows protected your PC", choose More info -> Run anyway (once per machine).
  First screen: "+ Create new config", then add your first cluster and - for anything behind a
  jump host - the jump host and your SSH key file. The app writes data\config_cluster.json.
  Confirm each jump host's key fingerprint once and trust each self-signed certificate once;
  both go to data\pins.json (fingerprints only). A config written by hand can be opened
  instead: JSON is what the app saves, and YAML (clusters.example.yaml) is read as input.

Optional
  elasticpro.exe --config C:\elasticpro\config_cluster.json   pre-provisioned config (jump server)
  Tick "Remember on this machine" in the sign-in dialog to keep the credential in the
  Windows Credential Manager (your account only) - the only thing that can leave this folder.

Read-only by default: the app only sends GET/HEAD and _search-family POSTs to Elasticsearch.
To act on a cluster - create or delete a snapshot, open/close/delete an index, send a PUT or
DELETE from the REST console - tick "Allow writes" on that page. That unlock lasts for the
session only, is never written to disk, and covers only the actions you take by hand: nothing
that refreshes on a timer can write. Setting readOnly: false in the config allows writes
everywhere instead.
