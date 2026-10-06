# Connect ElasticPro to Zabbix 7.0 (two machines)

This page connects an ElasticPro you **already run** to a Zabbix 7.0 you **already run** on a **different machine**. Everything after the first two steps is done in the two web UIs: ElasticPro shows a one-time **pairing code**, you paste it into Zabbix, and the two sides set themselves up. No secret files, no nginx edits, no API token copied by hand.

When you finish, Zabbix has an **ElasticPro** menu that opens the app already signed in as the Zabbix user, and ElasticPro reads its cluster list from the Zabbix API.

{.is-info}

## Before you start

You need:

- **Both addresses.** `<elasticpro-host>` is the name people type to open ElasticPro. `<zabbix-host>` is the name people type to open Zabbix, with the port if it is not 443 (for example `zabbix.example.com:9443`). You also need `<zabbix-web-ip>`, the IP address of the machine that runs the **Zabbix frontend** (the PHP web UI). It is not necessarily the Zabbix server.
- **ElasticPro running as the hosted Docker deployment** (`deploy/docker-compose.yml`) with the `deploy/nginx/nginx.conf` that ships with it. That file already forwards the two addresses Zabbix calls, `/sso/zabbix` and `/zabbix/pair`. The portable Windows app cannot do this: it has no Zabbix sign-in and no Zabbix sync.
- **A Zabbix Super admin** account (for example `Admin`).
- **sudo on the Zabbix web host**, to copy the module into place.
- **Both clocks synchronised with NTP.** Signed requests between the two machines expire after 60 seconds. Run `timedatectl | grep synchronized` on each machine; both should say `yes`.

Every command below uses placeholders in angle brackets. Replace them. Never paste a real token, secret or pairing code into a wiki page or a ticket.

## Ports and firewall

| # | From | To | Port | Why | Required |
|---|---|---|---|---|---|
| 1 | Users' browsers | Zabbix web (`<zabbix-host>`) | TCP 443, or your Zabbix web port (for example 8443 or 9443 on Docker) | the Zabbix UI | yes |
| 2 | Users' browsers | ElasticPro (`<elasticpro-host>`) | TCP 443 (the `LISTEN` value in ElasticPro's `.env`) | the browser loads ElasticPro **directly** inside the Zabbix frame, including its live-update stream | yes |
| 3 | Zabbix **web** host (`<zabbix-web-ip>`) | ElasticPro nginx | TCP 443 | server-to-server calls from the module: `POST /zabbix/pair` (pairing) and `POST /sso/zabbix` (every sign-in) | yes |
| 4 | ElasticPro host (the core container) | Zabbix web | TCP 443, or your Zabbix web port | the Zabbix API (`api_jsonrpc.php`), used by the cluster sync | yes |
| 5 | ElasticPro host | Zabbix **server** | TCP 10051 | trapper, only if you later run the client-plan scraper | optional |

**On the ElasticPro host**, with `ufw`:

```bash
sudo ufw allow proto tcp from <users-subnet>   to any port 443   # 2
sudo ufw allow proto tcp from <zabbix-web-ip>  to any port 443   # 3
```

Or with `firewalld`:

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="<users-subnet>"  port port="443" protocol="tcp" accept'
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="<zabbix-web-ip>" port port="443" protocol="tcp" accept'
sudo firewall-cmd --reload
```

**On the Zabbix host**, with `ufw`:

```bash
sudo ufw allow proto tcp from <users-subnet>      to any port 443     # 1
sudo ufw allow proto tcp from <elasticpro-ip>     to any port 443     # 4
sudo ufw allow proto tcp from <elasticpro-ip>     to any port 10051   # 5, optional
```

Or with `firewalld`:

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="<users-subnet>"  port port="443" protocol="tcp" accept'
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="<elasticpro-ip>" port port="443" protocol="tcp" accept'
sudo firewall-cmd --reload
```

(Use your Zabbix web port instead of 443 if it differs.)

> **Docker bypasses `ufw` and `firewalld`.** Docker adds its own iptables rules for published ports, and those rules come before the host firewall, so the rules above may not apply to the ElasticPro nginx or a Docker Zabbix frontend. To filter Docker traffic at the firewall, put rules in the `DOCKER-USER` chain. On the ElasticPro side, the restriction Docker cannot bypass is **Allowed sources** in Config → Zabbix (Step 6). Both calls from Zabbix are also signed, time-limited and single-use, so an address restriction is an extra layer, not the only one.
{.is-warning}

## How the two machines talk

```
browser ──443──► Zabbix web
browser ──443──► ElasticPro nginx          (the app, inside the Zabbix frame)
Zabbix web ──443 POST /zabbix/pair, /sso/zabbix (HMAC-signed)──► ElasticPro nginx ─► core
ElasticPro core ──443──► Zabbix web /api_jsonrpc.php   (API token, read-only methods)
```

---

## Step 1 — Open the ports

Apply the firewall commands above on both machines.

**Check it worked:** from the Zabbix web host, run this. It should print `401`: nginx passed the request and the core refused it because no pairing is in progress yet. `404` means the ElasticPro nginx is running an older `nginx.conf` that does not forward `/zabbix/pair`; replace it with the shipped one and run `docker compose restart nginx`.

```bash
curl -sk -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' https://<elasticpro-host>/zabbix/pair
```

From the ElasticPro host, `curl -sk -o /dev/null -w '%{http_code}\n' https://<zabbix-host>/` should print `200` or `302`.

## Step 2 — Zabbix web host: install and enable the module

The modules hold no secret: after pairing, their settings live in the Zabbix database.

**2a. Run the installer** on the Zabbix web host:

```bash
curl -fsSL https://github.com/karthick-dkk/elasticpro/releases/latest/download/zabbix-modules-install.sh | sudo bash
```

It downloads the modules from the latest release, checks their SHA-256, finds your Zabbix frontend (a package install, or a running `zabbix-web-*` container), and puts the five module folders in place with the right owner. A module already there is kept in a dated backup under `/var/backups/elasticpro-zabbix/`, and `config.php` is never touched. It is safe to run again to upgrade. At the end it prints what it installed and what is left to do in the UI.

Prefer to read a script before running it as root? Download it, read it, try it, then run it:

```bash
curl -fsSLO https://github.com/karthick-dkk/elasticpro/releases/latest/download/zabbix-modules-install.sh
less zabbix-modules-install.sh
sudo bash zabbix-modules-install.sh --dry-run      # shows every step, changes nothing
sudo bash zabbix-modules-install.sh
```

Useful options (`--help` lists them all):

| Option | When |
| --- | --- |
| `--dry-run` | see what it would do first |
| `--version vX.Y.Z` | a given release instead of the latest |
| `--from-dir <path>` | no internet on this host: a copy of the repository, or an unpacked release archive |
| `--modules-dir <dir> --owner <uid:gid>` | detection picks the wrong place, or you want it somewhere else |
| `--container <name>` | more than one Zabbix web container is running |
| `--package` | a package-installed Zabbix frontend **and** a Zabbix web container on the same host (with `--zabbix-url`, the one publishing that URL's port is chosen) |
| `--zabbix-url <url> --token-file <file>` | also register and enable the modules through the API (a Super admin API token, alone in a `chmod 600` file) |
| `--uninstall` | remove them again (disable them in the UI first, or give `--zabbix-url` and `--token-file`) |

*Zabbix in Docker:* if the web container has no host folder mounted at `/usr/share/zabbix/modules`, the installer puts the modules in `/opt/elasticpro/zabbix-modules` and prints the exact `volumes:` lines to add to the web service (files copied into a container are lost when it is re-created). Add them, then `docker compose up -d <zabbix-web-service>`.

> The installer puts all five ElasticPro modules in place. This page needs only **ElasticPro**; Cluster Management and the three report widgets can stay disabled until you use them.
{.is-info}

**2b. Or copy it by hand.** The same result, without the installer. Package the `elasticpro` folder on any machine that has the ElasticPro repository (for example the ElasticPro host), and copy it over:

```bash
# from the repository root (the folder that contains deploy/)
tar -C deploy/zabbix/module -czf /tmp/elasticpro-module.tgz --exclude=config.php elasticpro
scp /tmp/elasticpro-module.tgz <admin>@<zabbix-web-host>:/tmp/
```

Then put it in the Zabbix modules folder. Use the block that matches how your Zabbix frontend is installed.

*Zabbix frontend from packages (Apache, or nginx with php-fpm):*

```bash
# on the Zabbix web host
sudo tar -C /usr/share/zabbix/modules -xzf /tmp/elasticpro-module.tgz
WEBUSER=$(ps -eo user=,comm= | awk '$2 ~ /php-fpm|apache2|httpd/ && $1 != "root" {print $1; exit}')
echo "PHP runs as: $WEBUSER"        # usually www-data (Debian/Ubuntu), apache or nginx (RHEL)
sudo chown -R root:"$WEBUSER" /usr/share/zabbix/modules/elasticpro
sudo chmod -R u=rwX,g=rX,o= /usr/share/zabbix/modules/elasticpro
php -m | grep -qi '^curl$' && echo "php curl: ok" || echo "install php-curl first"
rm /tmp/elasticpro-module.tgz
```

*Zabbix frontend in Docker (the official `zabbix/zabbix-web-*` images run as uid 1997, gid 1995):*

```bash
# on the Zabbix web host
sudo mkdir -p /opt/zabbix-modules
sudo tar -C /opt/zabbix-modules -xzf /tmp/elasticpro-module.tgz
sudo chown -R 1997:1995 /opt/zabbix-modules/elasticpro
sudo chmod -R u=rwX,g=rX,o= /opt/zabbix-modules/elasticpro
rm /tmp/elasticpro-module.tgz
# add this line under the web service's `volumes:` in your Zabbix compose file:
#   - /opt/zabbix-modules/elasticpro:/usr/share/zabbix/modules/elasticpro:ro
docker compose up -d <zabbix-web-service>     # in your Zabbix compose folder
```

**2c. Enable it.** Skip this if you gave the installer `--zabbix-url` and `--token-file`: it has enabled the modules already. Otherwise, in Zabbix, go to **Administration → General → Modules** and click **Scan directory** (top right). Find **ElasticPro** in the list. If its status says **Disabled**, click it to enable it.

**Check it worked:** reload the page. An **ElasticPro** entry appears in the main menu directly after **Monitoring**, and **Administration** has a new **ElasticPro** entry at the bottom.

## Step 3 — Zabbix UI: set the Frontend URL

Go to **Administration → General → Other** and set **Frontend URL** to the address people open Zabbix at, for example `https://<zabbix-host>`. Click **Update**.

The module uses this as *this Zabbix's address* when it pairs. ElasticPro only accepts a pairing from the Zabbix address it was given in Step 4, compared by scheme, host and port. Without a Frontend URL, the module guesses the address from your browser request, which can differ (a different name, `http` behind a TLS proxy) and gets the pairing refused.

**Check it worked:** the page says *Configuration updated*, and **Administration → ElasticPro → This Zabbix's address** shows the same value.

## Step 4 — ElasticPro: enter the Zabbix URL and make a pairing code

**4a. Sign in as an ElasticPro administrator.** If this ElasticPro has never been signed in to, it has one account, `elasticpro`, with a password generated for this install alone. Read it on the ElasticPro host:

```bash
cd <deploy-dir>     # the folder that holds ElasticPro's docker-compose.yml
docker compose exec core cat /app/data/initial-admin-password
```

The core also logged the same password once, on the start that created the account: `docker compose logs core | grep "created the first one"`.

Open `https://<elasticpro-host>/` and sign in with that user name and password.

ElasticPro then asks for a new password (at least 10 characters). Nothing else works until you set it. Once it is set, `initial-admin-password` is deleted; the old password no longer opens anything.

> Open ElasticPro at the address **the Zabbix web host** can reach (`https://<elasticpro-host>`), not through `localhost` or an SSH tunnel. The address in your browser bar is the one the pairing code tells Zabbix to call back.
{.is-warning}

**4b. Enter the Zabbix URL.** Go to **Config → Zabbix**. In the **Zabbix connection** card, set **Zabbix URL** to the address people open Zabbix at, exactly as it appears in the browser bar: `https://<zabbix-host>` (add `/zabbix` if your Zabbix UI lives at that sub-path). Leave **API URL** empty; it defaults to the Zabbix URL plus `/api_jsonrpc.php`. Click **Save**.

**4c. Test the connection.** Click **Test connection**. If your Zabbix uses a certificate that the ElasticPro host does not already trust (self-signed, or a private CA), ElasticPro shows the certificate. Compare the SHA-256 with the certificate on the Zabbix web server, then click **Trust this certificate**.

**Check it worked:** the notice reads *Zabbix answers; no API token is set yet — pair, or paste one.* with the Zabbix version. That is the expected answer before pairing.

**4d. Make the pairing code.** Click **Pair with Zabbix…**. A dialog shows the one-time code. It is valid for **15 minutes**, works once, and is never shown again once you close the dialog. Click **Copy**, and leave the dialog open: it tells you when Zabbix has paired.

> The pairing code contains the secret the two sides will share. Treat it like a password: paste it only into Zabbix, never into chat, e-mail or a ticket. If it leaks, press **Pair with Zabbix…** again; a new code replaces the old one.
{.is-danger}

## Step 5 — Zabbix: paste the code and pair

As a Super admin, go to **Administration → ElasticPro**. Under **Pair with ElasticPro**:

- **Pairing code:** paste the code.
- **This Zabbix's address:** already filled in from the Frontend URL (Step 3). It must match the Zabbix URL you entered in ElasticPro.
- **API URL for ElasticPro:** leave empty unless ElasticPro reaches the Zabbix API at a different address from the one people use.
- **Verify TLS:** keep it ticked when ElasticPro has a certificate the Zabbix web host trusts. Untick it only for a self-signed test certificate, as in this screenshot.

Click **Pair**.

**Check it worked:** a green message reads *Paired with ElasticPro at https://&lt;elasticpro-host&gt;*, and **Connection** shows **Secret: set · paired &lt;date&gt; by &lt;you&gt;**. Click **Test connection** on the same page; it should say *ElasticPro connection works*.

What pairing did, acting as you through the Zabbix API: it created (or reused) the user role **ElasticPro sync** and the user **elasticpro-sync** (read-only API methods, no frontend access), made a new API token for that user, and sent the token to ElasticPro in a signed request. You do not need to copy or store the token anywhere.

## Step 6 — ElasticPro: confirm and sync

Back in ElasticPro, the pairing dialog now reads *Paired with https://&lt;zabbix-host&gt; (Zabbix 7.0.x). The code is spent.* Click **Done**.

The **Zabbix connection** card now shows **paired with https://&lt;zabbix-host&gt;**, the Zabbix version, **API token: set**, and *Sign-in from Zabbix: on · may frame this app: https://&lt;zabbix-host&gt;*. Pairing starts a sync by itself; to run one now, click **Sync now** in the **Zabbix** card below it. After that, the sync runs every five minutes (**Sync interval**).

**Check it worked:** the status reads *last sync OK — N cluster host(s)*, with no **Last sync failed** banner.

- Every Zabbix host that carries the template `Elasticsearch Cluster by HTTP EP` is listed as a cluster. If you have none yet, the table says so. That is normal: the sync still proved the API connection works.
  If your Zabbix already carries this template under a different name, set `ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE` on the ElasticPro server to that name instead of renaming the template in Zabbix.
- The yellow **Vault is not configured** banner and *Waiting for a working password* are expected if cluster passwords are Vault or Secret macros and this server has no Vault. Either set up Vault on the server (see `deploy/zabbix/README.md`, *Passwords: Vault, or ElasticPro's own*) or tick **Use ElasticPro credentials for Zabbix clusters**.
- *Optional hardening:* put the Zabbix web host's address in **Allowed sources** and click **Save**. Only that address may then call `/sso/zabbix` and `/zabbix/pair`. Use the address listed under **Recent changes** (*pairing — zabbix-module from &lt;address&gt;*): that is the address ElasticPro actually sees, which NAT or Docker can make different from `<zabbix-web-ip>`.

## Step 7 — Users and roles, on both sides

**How Zabbix users become ElasticPro users.** The user's **user type** in Zabbix decides their role in ElasticPro; Zabbix 7.0 sets the user type through the user's **role**. The ElasticPro account is created on first sign-in as `<zabbix-username>@zabbix`, has no password of its own, and its role and groups are refreshed from Zabbix at every sign-in.

| Zabbix user type | ElasticPro role | Clusters they see |
|---|---|---|
| User | `user` (read-only) | only clusters whose Zabbix host group one of their user groups can **read** |
| Admin | `operator` | all; may write, behind the write unlock |
| Super admin | `admin` | all; also administers the app |
| Guest | not signed in | none |

**7a. Zabbix: a user group that can see the clusters.** Go to **Users → User groups → Create user group**. Give it a name, for example `ES prod team`. On **Host permissions**, click **Add**, pick the host group that holds your Elasticsearch cluster hosts, and select **Read**. Click **Add**.

**7b. Zabbix: create a person.** Go to **Users → Users → Create user**. Fill in **Username** and **Password**, and put the user in the group from 7a.

On the **Permissions** tab, pick a **Role**: `User role` gives ElasticPro `user`, `Admin role` gives `operator`, `Super admin role` gives `admin`. Click **Add**.

**7c. ElasticPro: local accounts, for people who sign in directly.** Anyone who opens `https://<elasticpro-host>/` without going through Zabbix needs a local account. In ElasticPro, open **Accounts**. Accounts that came from Zabbix show the origin `zabbix`.

Click **+ New ElasticPro user**, enter a user name, a password of at least 10 characters and a role (`admin`, `operator`, `user` or `guest`), then click **Create**.

> A local account named like `jane.doe@zabbix` blocks the Zabbix user `jane.doe` from signing in. Local accounts should not end in `@zabbix`.
{.is-info}

## Step 8 — Open ElasticPro from Zabbix

In Zabbix, click **ElasticPro → Clusters**. The menu also has **Indices**, **Snapshots & SLM** and **REST console**; Super admins also see **Config**. ElasticPro loads inside Zabbix, already signed in as the Zabbix user.

> **Done.** Every page load gets its own single-use sign-in code, valid for 60 seconds, so there is nothing to renew.
{.is-success}

### Verification checklist

- [ ] Zabbix **Administration → ElasticPro** shows **Secret: set · paired …**, and **Test connection** there says *ElasticPro connection works*.
- [ ] ElasticPro **Config → Zabbix** shows **paired with https://&lt;zabbix-host&gt;**, the Zabbix version and *last sync OK*.
- [ ] `curl -skI https://<elasticpro-host>/ | grep -i content-security-policy` shows `frame-ancestors https://<zabbix-host>`.
- [ ] From the Zabbix web host, `POST /zabbix/pair` returns `401` (Step 1); `curl -sk -o /dev/null -w '%{http_code}\n' https://<elasticpro-host>/sso/anything` returns `404`.
- [ ] A Zabbix **Super admin** opens **ElasticPro → Clusters** and appears in ElasticPro **Accounts** as `<name>@zabbix` with role `admin`.
- [ ] A Zabbix **User** in the group from 7a sees only the clusters in that group's host group.
- [ ] A local ElasticPro account can still sign in directly at `https://<elasticpro-host>/`.

## Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| Zabbix: *ElasticPro refused the pairing (HTTP 401): origin_mismatch …* | **This Zabbix's address** differs from the **Zabbix URL** in ElasticPro (scheme, host or port) | Set the Frontend URL (Step 3), make both values identical, then make a new code (4d) and pair again |
| Zabbix: *this pairing code expired …*, or *refused the pairing (HTTP 401): unauthorized pairing refused* | The code is older than 15 minutes, was already used, or a newer code replaced it | Click **Pair with Zabbix…** in ElasticPro again and paste the newest code |
| ElasticPro: **Pair with Zabbix…** is greyed out, or fields say *managed by server config* | The core has server-side Zabbix settings (`ELASTICPRO_ZABBIX_*` environment variables); a server-set sign-in secret turns pairing off | Remove those variables from the core's environment and recreate it (`docker compose up -d core`), or stay on the server-managed path (appendix) |
| Zabbix: *config.php in the module folder still sets … and wins* | An old `config.php` from a manual install is in the module folder | Remove `config.php` from the module folder; the paired settings then take over |
| Zabbix: *could not reach ElasticPro at …/zabbix/pair*, or *HTTP 404 — does its nginx pass /zabbix/pair?* | Port 443 blocked from the Zabbix web host, a self-signed ElasticPro certificate with **Verify TLS** ticked, or an old ElasticPro `nginx.conf` | Rerun the Step 1 curl on the Zabbix web host and follow what it returns |
| The ElasticPro frame in Zabbix is blank; the browser console shows a `frame-ancestors` error | The **Zabbix URL** in ElasticPro is not exactly the address in the browser bar | Correct the Zabbix URL in Config → Zabbix and **Save**; the card's *may frame this app* line shows the value in force |
| The frame shows a sign-in error: *too old or from the future*, or HTTP 403 | Clocks more than 60 s apart, or **Allowed sources** does not include the address ElasticPro sees for the Zabbix web host | Turn on NTP on both machines (`timedatectl set-ntp true`); fix or clear **Allowed sources** |
| **ElasticPro** missing from **Modules** or from the Administration menu, or the page gives HTTP 500 | Wrong folder, files not readable by the PHP user, php-curl missing, or you are not a Super admin | Check Step 2b (path, `chown`, `php -m \| grep curl`), click **Scan directory** again, sign in as a Super admin |

**Rotating the token or disconnecting.** To rotate, make a new code and pair again: Zabbix makes the new token first and deletes the previous pairing's token only after ElasticPro accepts it, so sign-in keeps working throughout. To disconnect, click **Unpair** on **both** sides: in Zabbix (**Administration → ElasticPro**, which deletes the token the pairing made) and in ElasticPro (**Config → Zabbix**, which stops sign-in from Zabbix at once and drops the Zabbix clusters).

## Appendix — Server-managed alternative

Some teams prefer to keep the connection in files on the servers instead of in the two UIs. That path still works and **wins field by field** over anything set by pairing:

- On the ElasticPro core, environment variables such as `ELASTICPRO_ZABBIX_URL`, `ELASTICPRO_ZABBIX_API_TOKEN_FILE` and `ELASTICPRO_ZABBIX_SSO_SECRET_FILE`. Config → Zabbix then shows those fields as *managed by server config*, and pairing is off while the sign-in secret is set this way.
- In the Zabbix module folder, a `config.php` (from `config.php.example`). **Administration → ElasticPro** then shows those fields as coming from `config.php`, and its **Or enter it by hand** section is for a secret managed on the server.

The full walk-through is in the repository: `deploy/zabbix/README.md`, section *Setting it up by hand (server-managed)*, and `deploy/zabbix/INTEGRATION.md`. The complete list of settings and what they override is in `docs/HANDBOOK.md`, *Zabbix connection — the message contract*.
