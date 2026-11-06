# Roles: who may do what, and where it is decided

ElasticPro has four roles — `admin`, `operator`, `user`, `guest` — and one more state a person
can be in: **No access**. Local accounts get their role on the Accounts page. Accounts that sign
in from Zabbix (`<username>@zabbix`) get theirs from the **role map**, unless an administrator
set the person's role by hand. This page is the contract for the Zabbix half: what decides a
role, the messages the Config page uses, and what the Zabbix modules send.

Source: `crates/elasticpro-core/src/zbx_sso.rs` (`RoleMap`), `auth.rs` (`Account`, the pins),
`bridge.rs` (`rolemap_msg`, `zabbix_users_msg`, the sign-in). Tests: `tests/zabbix_roles.rs`.

## How a Zabbix sign-in gets its role

In this order; the first that applies wins.

1. **A role set by hand** on that person (pinned). It stays through sign-ins and syncs until
   someone presses Reset (`USER_UNPIN_ROLE`). **No access** is one of the choices: the person
   is refused at sign-in, their open sessions end, and every request from a session that was
   still resolving is refused (`no_access`, EP-108) — whatever Zabbix and the map say.
2. **Their Zabbix user groups.** Each ElasticPro role holds any number of Zabbix user groups
   (`zabbix.roleMap.groups`). A person in several mapped groups gets the **highest**. Groups
   are matched by id when the module sent ids (modules 2.1.20) and the map entry has one, else
   by name — exactly, as Zabbix compares them (`NOC` is not `noc`).
3. **In none of the mapped groups**, the `unmapped` rule:
   - `zabbixRole` (the default, and today's behaviour): the Zabbix role's *name* if the map's
     `names` table knows it, else the Zabbix *user type* (`types`: 1 User → `user`, 2 Admin →
     `operator`, 3 Super admin → `admin`; guests nothing).
   - `none`: not signed in (`no_role`, EP-513, the message names their groups).

ElasticPro only *reads* Zabbix group membership; it never changes a Zabbix user, group or role.
Which clusters a person sees is a separate question (`zabbix.scopeUsersByGroup`, host-group
rights in Zabbix) and is not touched by any of this.

**Migration.** A config written before the group map has `names`/`types` only. It behaves
exactly as before until an administrator saves the group table: `groups` are empty and
`unmapped` is `zabbixRole`, so step 2 never matches and step 3 is the old rule. Saving the
group table (`ZABBIX_ROLEMAP_SET` with `groups` only) keeps `names` and `types` in the file —
the message is a partial update — so a site's older role-name entries keep working for people
in no mapped group. `ZABBIX_ROLEMAP_GET` says `groupMapSaved: false` until then.

**The last administrator.** Nothing may leave zero administrators able to sign in: not a role
change, a block, a lock, a hand-back to Zabbix, a No access pin — nor a role map. For the map
the core counts local admins, pinned Zabbix admins, and Zabbix accounts the *new* map would make
admin from their groups (as Zabbix lists them now when the API can be asked, else as their last
sign-in recorded them). Zero refuses the save (`last_admin`, EP-109) and writes nothing. A
Zabbix administrator whose groups were never recorded (last sign-in before 0.3.55, or an embed
module older than 2.1.20 that sends no groups) is **not** counted until they sign in again; the
refusal says so.

## The config file

```yaml
zabbix:
  roleMap:
    groups:
      admin: ["ElasticPro admins", { id: "7", name: "Zabbix administrators" }]
      operator: ["NOC leads"]
      user: ["NOC", "Client A team"]
      guest: ["Auditors"]
    unmapped: zabbixRole        # or: none
    names: { "ES owners": admin }     # older role-name map, the unmapped fallback
    types: { "1": user, "2": operator, "3": admin }
```

A group is a name, or `{id, name}` (Zabbix's `{usrgrpid, name}` is accepted on the way in).
Bounds: 256 groups in all, names 1–255 characters, ids numeric. A malformed entry in the file is
skipped (never a lock-out); the same mistake in a message is refused.

## Messages (all admin only, hosted)

Every refusal is `{ ok: false, kind, message }`; `kind` codes are in docs/ERROR-CODES.md.

### `ZABBIX_ROLEMAP_GET`

```json
{ "ok": true,
  "roleMap": { "groups": { "admin": [...], "operator": [...], "user": [...], "guest": [...] },
               "unmapped": "zabbixRole" | "none",
               "names": { "<Zabbix role name>": "admin|operator|user|guest|none" },
               "types": { "1": "user", "2": "operator", "3": "admin" } },
  "defaults": { ...the shipped map... },
  "file": true,                    // false: no config file; the defaults apply
  "groupMapSaved": false,          // true once any group is listed or unmapped is "none"
  "zabbixGroups": [{ "usrgrpid": "7", "name": "NOC", "disabled": false }] | null,
  "zabbixGroupsError": null | "why Zabbix's user groups could not be listed",
  "zabbixRoles": [{ "roleid": "3", "name": "Admin role", "type": 2 }] | null,
  "zabbixError": null | "why Zabbix's roles could not be listed" }
```

Every group entry in `roleMap.groups` is either a string (no id known) or `{ "id", "name" }`.
`zabbixGroups` is for "+ Add group": send the chosen group as `{ "id": usrgrpid, "name" }`.

### `ZABBIX_ROLEMAP_SET` `{ roleMap: { groups?, unmapped?, names?, types? } }`

A partial update: a section left out stays as it is; one given replaces that section whole.
`groups` keys are the four roles (a key left out is an empty row); a group listed under two
roles is refused ("a group belongs to one role; a person in several groups gets the highest").

Answer: `{ ok: true, roleMap, keptVersion, adminsAfter, groupMapSaved }`. Refusals: `bad_message`
(a malformed map, with the first reason), `last_admin` (`adminsAfter: 0`), the config-file
refusals (`no_config`, `not_found`, `parse_error`, `io_error`).

The change applies from each person's **next sign-in**; nobody's open session changes.
Audited: `zabbix role map changed` with the map and `admins_after`.

### `ZABBIX_ROLEMAP_PREVIEW` `{ roleMap: { ...a draft, same shape as SET... } }`

No writes. The draft is checked exactly as a save would be (`bad_message` on a mistake).

```json
{ "ok": true, "roleMap": { ...the draft, complete... },
  "changes": [ { "account": "d.new@zabbix", "username": "d.new",
                 "from": "user", "to": "none",          // role in force now → under the draft
                 "source": "group" | "zabbixRole" | "unmapped", "via": "NOC" | null,
                 "groups": ["Zabbix users"], "disabled": false } ],
  "adminsAfter": 1, "lockout": false,            // lockout: the save would be refused
  "groupsFrom": "zabbix" | "lastSignIn", "zabbixError": null | "..." }
```

`changes` lists only people whose **role in force** would differ at their next sign-in.
Pinned people (No access included) never appear: the pin wins over any map. People whose groups
were never recorded cannot be judged and are left out.

### `ZABBIX_USERS`

```json
{ "ok": true, "total": 36, "byHand": 2, "groupMapSaved": true,
  "groupsFrom": "zabbix" | "lastSignIn",       // where each person's groups come from
  "zabbixError": null | "why Zabbix could not be asked (not paired, down, no user.get)",
  "users": [ {
    "account": "a.kumar@zabbix", "username": "a.kumar", "known": true,
    "groups": [ { "id": "3", "name": "NOC", "role": "user" }, { "id": "2", "name": "NOC leads", "role": "operator" } ],
    "zabbixUserType": 1, "zabbixRole": "User role",
    "fromGroups": { "role": "operator", "source": "group", "via": "NOC leads",
                    "matched": [ { "group": "NOC leads", "role": "operator" }, { "group": "NOC", "role": "user" } ] },
    "byHand": null | "admin" | "operator" | "user" | "guest" | "none",
    "pinned": false, "noAccess": false,
    "inForce": "operator",                      // what their sessions have now ("none" = No access)
    "disabled": false, "locked": false,
    "lastSignIn": 1762345678, "factsAt": 1762345678 } ] }
```

- `groups[].role` is what the map gives that group (`null`: not mapped) — the page's "(not
  mapped)" mark. `fromGroups.matched` is every mapped group they are in, highest first — the
  page's "highest of User, Operator". `fromGroups.source` is `zabbixRole` when the fallback
  decided and `unmapped` when it refuses (`role: null`).
- `inForce` can differ from `fromGroups.role` when the map changed since the person last signed
  in: the preview is what shows that.
- `known: false`: this account signed in before groups were recorded; its `groups` are empty
  and `fromGroups` is `null` until the next sign-in (or until Zabbix can be asked).
- When Zabbix can be asked (`user.get` on the paired token), every row's groups, role name and
  user type are as Zabbix has them **now**, not as the last sign-in said (`groupsFrom: "zabbix"`).

### `USER_SET_ROLE` `{ name, role }` — `role` may now be `"none"`

`"none"` (or `"no access"`) sets the person's role by hand to No access: `set_no_access` pins
it, ends every session of theirs, and answers `{ ok, pinned: true, noAccess: true, users }`.
Refused for a local account (`bad_request`: block it instead), for yourself, and for the last
administrator able to sign in (`forbidden`). A real role set by hand afterwards replaces No
access (`noAccess: false` in the answer). `USER_LIST` rows carry `noAccess` and `roleInForce`
(`"none"` when No access, else the role).

### `USER_UNPIN_ROLE` `{ name }` — Reset

Clears the pin, No access included: the next sign-in follows the map (a lifted No access lets
them sign in again at once; a lifted role keeps its value until that sign-in). Refused for the
last administrator able to sign in.

## What the Zabbix modules send (2.1.20)

`POST /sso/zabbix` (the sign-in) and `GET /sso/zabbix/role` (Cluster Management's "who may
edit") both carry the person's user groups with ids:

```json
{ "username": "a.kumar", "zabbix_user_type": 1, "zabbix_role": "User role", "zabbix_roleid": 1,
  "groups": ["NOC", "NOC leads"],
  "user_groups": [ { "id": "3", "name": "NOC" }, { "id": "2", "name": "NOC leads" } ],
  "ts": 1762345678, "nonce": "..." }
```

`groups` (names) stays for the cluster scope and for cores older than 0.3.55, which ignore
`user_groups`. A module older than 2.1.20 sends names only; the core then matches the group map
by name. The role lookup's answer gains `no_access` (bool) and `role_source`; for a person set
to No access it answers `role: "none"` **and** `zabbix_role: "none"`, so a module that takes an
unknown role string as "no role" cannot fall through to the Zabbix user type.

The paired **ElasticPro sync** role needs `user.get` for the live `ZABBIX_USERS` read
(`usergroup.get` it had already). A site paired before modules 2.1.20 gets it by pairing
again (the pairing updates the role) or by adding `user.get` to the role's API methods by hand;
until then the tables show each person's groups as their last sign-in said (`groupsFrom:
"lastSignIn"`, `zabbixError` names the missing permission).

## Audit

`zabbix sign-in code issued` now carries `source` (`group` | `zabbixRole`), `via` (the group)
and `pinned`; `role changed: no access` is the pin; `zabbix role map changed` carries
`admins_after`; a refused map logs `zabbix role map refused`.
