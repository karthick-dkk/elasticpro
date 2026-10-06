# HashiCorp Vault (community edition) for ElasticPro and Zabbix.
# One node, integrated storage. TLS is off because the listener is reachable only on the
# `vault_net` Docker network (members: Vault, the Zabbix server, the ElasticPro core)
# and on the host's loopback. Put TLS on before anything else joins that network.
ui            = true
disable_mlock = true          # Raft storage: mlock is not recommended with integrated storage

storage "raft" {
  path    = "/vault/file"   # the image chowns this directory to the vault user on start
  node_id = "vault-1"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

api_addr     = "http://vault:8200"
cluster_addr = "http://vault:8201"
