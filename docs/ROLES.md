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

**At every sync — down only.** Each Zabbix sync (the timer and `ZABBIX_SYNC`) lists Zabbix's
users with their groups (`user.get`) and re-runs the same `resolve_claim` for every *unpinned*
Zabbix account. A role the live groups no longer justify is **lowered at once** — to the lower
role, or to no access (`noAccess: true` with `pinned: false`) — and the person's sessions end.
**No role is ever raised** at a sync: a raise waits for the next signed sign-in, the only claim
the core trusts upwards. The cluster *scope* is not a role: for every listed person, pinned or
not, it follows the live groups as a sign-in's would, computed for the role in force after the
sync (`scope_for`), and may widen or narrow — a pin covers the **role only**, so a pinned user
removed from a Zabbix group loses that group's clusters at the sync, while a pinned (or any)
administrator's scope is always None and is never narrowed. The step fails closed towards *no
change*: when `user.get` is refused
(a token without it), fails, answers nothing, or names none of the accounts this core knows,
nobody moves. People the answer lists are judged on the groups it lists for them. People it does
**not** list depend on whether the list is complete — the sync token's own user is of the Super
admin type (`user.checkAuthentication {token}`, else that user's `role.type`), the one type whose
`user.get` sees every user; `userListComplete` in the sync's answer says which:

- **Complete** and absent → deleted in Zabbix: their sessions end at once and, unless pinned,
  they get no access (`noAccess: true`, `pinned: false`; a deleted user cannot produce a signed
  sign-in, and were they recreated, one that gives a role lifts it). Recorded as a `syncChange`
  with `why: "not in Zabbix any more"` and listed under `deleted`. A pinned person keeps the
  pin but loses the sessions. Either way the account is marked **`gone`**, and a gone account
  counts as no administrator for every guard (a deleted pinned admin cannot be the one the
  guards rely on). `gone` is cleared when a list names them again, when they sign in (a
  recreated user), and by Reset. The absent are handled before the listed, so an administrator
  the list cannot vouch for is discounted before any listed one is judged against the guard.
  Note: pointing the Zabbix link at **another Zabbix instance** makes every account that
  instance does not know "gone" at the next sync (sessions end; unpinned ones get no access);
  Reset on each row, or a sign-in from the instance that knows them, reverses it.
- **Partial**, or not known to be complete, and absent → nothing is known about them: the role
  is kept, they are listed as `unverifiable` (sync answer, `ZABBIX_CLUSTERS`, and
  `unverifiable: true` / `absentSyncs` on their `ZABBIX_USERS` and `USER_LIST` rows), an
  audit warning is logged, and after **`ABSENT_SYNCS_BEFORE_SIGN_OUT` = 3** consecutive absent
  syncs their sessions end so the next request needs a fresh signed sign-in. Being listed by a
  later sync, or signing in, verifies them again (`absentSyncs` back to 0).

**What a list can and cannot say.** Groups are judged only from a **complete** list: a token
that is not a Super admin is answered `usrgrps: []` for users it may not see, so a listed user
with no groups is skipped (logged, never evidence), and an answer in which every listed account
has no groups is unusable as a whole — nothing moves, nobody is marked. Zabbix user names are
case-sensitive while ElasticPro accounts compare names without case; when two Zabbix users fold
to one account the account is not judged (listed under `ambiguous`). The sync's answer and
`ZABBIX_CLUSTERS` carry `userListComplete`, `roleChanges`, `deleted`, `unverifiable` and
`ambiguous` (admin only).

**Admin counting.** Conservative in both directions. An *unverifiable* account (absent from a
partial list) still counts as an administrator for every last-admin guard — the map's
(`adminsAfter`, `last_admin`), and `USER_SET_ROLE`/block/lock/No access/remove — so a sync token
that sees only some users cannot make every change refusable for ever; `unverifiable` is shown,
not acted on. A *gone* account (absent from a complete list) counts for nothing in every guard,
pinned or not: a deleted user cannot sign in. An unpinned one is also set to no access — unless
it was the last administrator, in which case the role is kept and logged (the site then needs
a local administrator). Hand pins are never flipped by a sync (their scope still follows the
groups, as above).

Pinned people, No access by hand, blocked accounts and the last administrator able to sign in
are never lowered (the last admin case is logged: `role kept at sync`). A no access the sync
imposed is lifted by the next signed sign-in that gives a role, by Reset, or by a role set by
hand. Each lowering is audited (`role lowered at sync`, with from → to and why), kept on the
account (`syncChange` in `ZABBIX_USERS` and `USER_LIST`) and listed in the sync's answer and in
`ZABBIX_CLUSTERS` (`roleChanges`, `userListComplete`, `unverifiable`; admin only). The worker
never does this; only the core.

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
    "lastSignIn": 1762345678, "factsAt": 1762345678,
    "syncChange": null | { "at": 1762345678, "from": "operator", "to": "user", "why": "the highest of their Zabbix user groups now gives user (NOC)" },
    "unverifiable": false, "absentSyncs": 0, "gone": false } ] }
```

- `groups[].role` is what the map gives that group (`null`: not mapped) — the page's "(not
  mapped)" mark. `fromGroups.matched` is every mapped group they are in, highest first — the
  page's "highest of User, Operator". `fromGroups.source` is `zabbixRole` when the fallback
  decided and `unmapped` when it refuses (`role: null`).
- `byHand: "none"` with `pinned: true` is No access by hand. `noAccess: true` with `pinned:
  false` is no access a sync imposed (see "At every sync"); `syncChange` says when and why.
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
by name. The role lookup's answer gains `no_access` (bool) and `role_source` (`group` |
`zabbixRole` | `unmapped`), and says **"none"** wherever it gives no role — `zabbix_role:
"none"` when the map gives nothing (a role name mapped to none, or the unmapped rule), and
`role: "none"` too for a person set to No access or one never seen whom the map refuses — never
`null`, which the module takes as "the core did not say" and answers from the Zabbix user type.
`map_role` carries the map's raw answer for the person as they are now (`"none"` or a role)
beside the account's own `role` and `pinned`: modules 2.1.20 **deny when `map_role` is `"none"`
and the role is not pinned**, even while `role` still carries what an earlier sign-in gave
(a held role does not outlive the map), deny on `no_access`, treat a `null` beside a
`role_source`/`map_role` as no role, and keep the user-type fallback only for a core too old to
send either. A pinned role is the administrator's word and wins. Zabbix user names are case-sensitive;
ElasticPro account names are compared without case, so `Alice` and `alice` in Zabbix are one
account here (the sync refuses to judge such an account).

The paired **ElasticPro sync** role needs `user.get` for the live `ZABBIX_USERS` read
(`usergroup.get` it had already). A site paired before modules 2.1.20 gets it by pairing
again (the pairing updates the role) or by adding `user.get` to the role's API methods by hand;
until then the tables show each person's groups as their last sign-in said (`groupsFrom:
"lastSignIn"`, `zabbixError` names the missing permission).

## Audit

`zabbix sign-in code issued` now carries `source` (`group` | `zabbixRole`), `via` (the group)
and `pinned`; `role changed: no access` is the pin; `zabbix role map changed` carries
`admins_after`; a refused map logs `zabbix role map refused`.
