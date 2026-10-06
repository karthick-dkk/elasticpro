# Lab: run the desktop core against a local jump host

```bash
# 1. something that answers like Elasticsearch on https://127.0.0.1:9470/c1 … /c3 (see below)

# 2. a restricted sshd on 127.0.0.1:2222 acting as the jump host
useradd --system --create-home --shell /usr/sbin/nologin jump; usermod -p '*' jump   # '*' = no password, NOT locked
ssh-keygen -t ed25519 -N '' -f /tmp/lab/client_ed25519
install -d -m700 -o jump -g jump /home/jump/.ssh
( printf 'restrict,port-forwarding,permitopen="*:9470" '; cat /tmp/lab/client_ed25519.pub ) > /home/jump/.ssh/authorized_keys
chown jump:jump /home/jump/.ssh/authorized_keys; chmod 600 /home/jump/.ssh/authorized_keys
cat > /tmp/lab/sshd_config <<CFG
Port 2222
ListenAddress 127.0.0.1
HostKey /tmp/lab/host_ed25519
PasswordAuthentication no
AllowTcpForwarding yes
PermitOpen *:9470
PermitTTY no
Match User jump
    ForceCommand /bin/false
CFG
ssh-keygen -t ed25519 -N '' -f /tmp/lab/host_ed25519; mkdir -p /run/sshd; /usr/sbin/sshd -f /tmp/lab/sshd_config

# 3. the core with the UI in a browser
cargo run -p elasticpro-core --features bridge --bin elasticpro-bridge -- ui 8765
#    open http://127.0.0.1:8765/ and pick lab/clusters.yaml (edit keyFile / paths first)
```

`clusters.yaml` here routes two clusters through `jumpwin` (127.0.0.1:2222) and one directly;
`clusters-nocred.yaml` has no credential and an encrypted key, to exercise both prompts.

## What stands in for Elasticsearch

Both files point at `https://127.0.0.1:9470/c1` … `/c3`. Anything that answers Elasticsearch's
`_cluster/health`, `_cat` and `_nodes` on that address will do — a real cluster, an SSH forward to
one, or a fixture. This repository ships one fixture, `tools/mock-es.mjs`, and it is a single
cluster on plain HTTP:

```bash
node tools/mock-es.mjs 9470        # http://127.0.0.1:9470 — then edit the URLs in clusters.yaml
                                   # to http://127.0.0.1:9470 (no path, no TLS)
```

That is enough to exercise the jump-host path, which is what this lab is for: the tunnel, the host-key
prompt and the reconnect behaviour do not care what is on the far end. It is **not** enough for the
fleet-scale work — the hundred-cluster TLS fixture those measurements were taken against is not part
of this repository, so a figure quoted for 80 or 120 clusters cannot be reproduced from a clone alone.
Put a multi-cluster TLS endpoint on 9470 yourself if that is what you are testing.
