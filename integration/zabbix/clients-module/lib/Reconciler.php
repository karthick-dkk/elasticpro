<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

use API;
use Exception;

/**
 * Makes Zabbix match a client: its host group, master host, cluster host, log archive host and
 * one Linux host per server, named after its roles: <client>-ES-Data-Parser-Engine-<n>.
 *
 * Hosts already in the client's group are taken on as they are — the cluster host by its
 * Elasticsearch template, a server by its IP — keeping their history and passwords, and are
 * renamed to the client's pattern. So is a host elsewhere in Zabbix with a server's IP, when it
 * belongs to no other client: an IP is one client's only. A server not in Zabbix is created,
 * linked to its roles' templates (the Linux agent template unless a role names others). A server
 * joins the group of each of its roles and of each family they count in (the groups the cluster
 * and Linux templates count); changing its roles moves it between those groups, and no group the
 * roles do not name is ever touched. Only hosts this page made carry the tag
 * managed-by: elasticpro-clients, and only those are ever deleted. Groups are never deleted.
 *
 * Every host the page keeps carries ep-client and ep-kind tags; a server also one ep-role per
 * role and one ep-service per role or extra service, and inv:<name> tags for its attributes —
 * the groundwork of host inventory. Macros are written one at a time: a host's other macros, and
 * secret values, stay as they were.
 *
 * Everything this class reads is read in both generations of the names (see "the old generation"
 * below) and written in the current one only.
 */
class Reconciler {

	public const MANAGED = ['tag' => 'managed-by', 'value' => 'elasticpro-clients'];
	public const MASTERS_GROUP = 'ElasticPro clients';
	public const CLUSTER_GROUP = 'Elasticsearch clusters';
	public const ULM_GROUP = 'Log archive';
	/** Ours, which the page writes; only the Elasticsearch one is a name a site may have changed. */
	public const OWN_CLUSTER_TEMPLATES = ['ElasticPro client plan', 'ElasticPro alerts', 'ElasticPro log delay',
		DevicesTemplate::NAME];
	/** Through a jump host, these replace the HTTP ones on the cluster host. */
	public const JUMP_CLUSTER_TEMPLATES = [JumpTemplate::NAME, 'ElasticPro client plan', 'ElasticPro alerts', 'ElasticPro log delay'];
	public const ULM_TEMPLATE = 'ElasticPro log archive S3';
	/** Tags this page writes; everything else on a host is left as it is. */
	private const OWN_TAGS = ['ep-client', 'ep-kind', 'ep-role', 'ep-service', 'ep-status', 'client', 'role'];
	/**
	 * Neither spelling of the already-off marker is in OWN_TAGS, and neither may be added.
	 *
	 * ep-was-off and evp-was-off look like tags this page owns — they carry its prefix, and
	 * ownTags() would derive the old spelling from the new one as it does for ep-status — but
	 * they belong to Lifecycle, which strips both spellings itself before writing one back, so
	 * there is no stale pair here for tags() to clean. Stripping them would instead destroy the
	 * one thing they are for: Lifecycle::enable() reads both spellings to decide which hosts were
	 * already Not monitored before the client was disabled, and leaves exactly those off. tags()
	 * runs on every save, including a save of a disabled client, so adding either name here would
	 * wipe that record and the next Enable would switch on machines an operator had deliberately
	 * left off. ep-status is the opposite case and is in OWN_TAGS: this page writes it, so it has
	 * to take both spellings off first.
	 */

	/** The prefix of this page's own tags, and so of every tag it writes. */
	public const TAG_PREFIX = 'ep-';
	/** The macro the Elasticsearch password is kept in, on the cluster and log archive hosts. */
	public const ES_PASSWORD_MACRO = '{$ELASTICSEARCH.PASSWORD}';

	/* ---------------------------------- the old generation ----------------------------------
	 *
	 * The product was renamed from ElasticVue Pro to ElasticPro, and this module's tags, template
	 * names and managed-by marker were renamed with it. The production Zabbix — seven clients and
	 * some forty hosts — still carries the old values, and no migration is going to be run, so
	 * they are recognised for good. They are matched, never written: every host a save touches
	 * comes out on the current generation, which is why tags() strips both spellings of its own
	 * tags and writes one set back.
	 *
	 * Reading only the current names was not a cosmetic fault. clients() matched no master host,
	 * so Cluster Management listed no clients at all — and Backups::take() walks that same list
	 * and keeps the last three, so three saves of an empty list would have destroyed every backup
	 * of the seven live clients. isManaged() said no, so the first save of a live client would
	 * have un-managed it, after which remove() leaves its hosts behind. clientGroups() came back
	 * empty, so every host looked unowned and the guard that keeps one client's server out of
	 * another client's hands never fired.
	 */

	/** Legacy value, kept for recognition: how a host this page made was marked before the rename. */
	public const LEGACY_MANAGED = ['tag' => 'managed-by', 'value' => 'elasticvue-clients'];
	/** Legacy value, kept for recognition: the group every master host is in on the live install. */
	public const LEGACY_MASTERS_GROUP = 'ElasticVue clients';
	/**
	 * Legacy values, kept for recognition: the master template's name before the rename. The
	 * first is the name 2.7.x wrote; the second is the spelling reported on the live install.
	 * Both are matched — a name matched one too many costs a filter value, and the name missed is
	 * the one that shows an operator zero clients.
	 */
	public const LEGACY_MASTER_TEMPLATES = [MasterTemplate::LEGACY_NAME, 'ElasticVue client master'];
	/** Legacy value, kept for recognition: the log archive template's name before the rename. */
	public const LEGACY_ULM_TEMPLATE = 'ElasticVue Pro log archive S3';
	/** Legacy prefix, kept for recognition: ep-client and the rest were evp-client and the rest. */
	public const LEGACY_TAG_PREFIX = 'evp-';
	/**
	 * Legacy value, kept for recognition: the name Roles::DEFAULT_CLUSTER_TEMPLATE shipped with
	 * before the rename, which is the name the live install's cluster hosts carry.
	 *
	 * The cluster template's name is a setting (Roles::clusterTemplate()), so a site may have
	 * pointed the Roles page at this spelling on purpose — in which case it is current, not
	 * legacy, and esClusterTemplates() must not list it twice. It is matched when a cluster host
	 * is being recognised and never linked: apply() links Roles::clusterTemplate() alone.
	 */
	public const LEGACY_CLUSTER_TEMPLATE = 'Elasticsearch Cluster by HTTP EVP';

	/** @var ClientSpec */
	private $spec;
	/** @var array */
	private $roles;
	/** @var string[] */
	private $done = [];
	/** @var array group name => id */
	private $groupIds = [];
	/** @var string the client's status while applying: active, disabled or decommissioned */
	private $status = 'active';

	public function __construct(ClientSpec $spec) {
		$this->spec = $spec;
		$this->roles = $spec->roles();
	}

	public function done(): array {
		return $this->done;
	}

	public function note(string $line): void {
		$this->done[] = $line;
	}

	/* ------------------------------------ reading ------------------------------------ */

	/**
	 * The two template names a site may have changed. They are a setting, not a constant: a
	 * Zabbix that calls them something else is pointed at them on the Roles page.
	 */
	public static function clusterTemplates(): array {
		return array_merge([Roles::clusterTemplate()], self::OWN_CLUSTER_TEMPLATES);
	}

	public static function agentTemplate(): string {
		return Roles::defaultTemplate();
	}

	/** The old generation's spelling of one of this page's own tags: ep-role was evp-role. */
	public static function legacyTag(string $tag): string {
		return strpos($tag, self::TAG_PREFIX) === 0
			? self::LEGACY_TAG_PREFIX.substr($tag, strlen(self::TAG_PREFIX))
			: $tag;
	}

	/** Both generations of the master template's name. */
	public static function masterTemplates(): array {
		return array_merge([MasterTemplate::NAME], self::LEGACY_MASTER_TEMPLATES);
	}

	/** Both generations of the log archive template's name. */
	public static function ulmTemplates(): array {
		return [self::ULM_TEMPLATE, self::LEGACY_ULM_TEMPLATE];
	}

	/**
	 * Both generations of the Elasticsearch template's name: whatever the Roles page says, and
	 * the spelling the pre-rename release shipped. array_unique, because a site that pointed the
	 * Roles page at the old name has one name, not two.
	 *
	 * For recognising a host, never for linking one. A reader that knew only the current name saw
	 * no cluster host on a pre-rename client at all: Cluster Management's list of "Elasticsearch
	 * clusters with no client yet" came back empty, and current() reported the client as having
	 * no cluster host, which is what sent a save into the create branch for a host that already
	 * existed.
	 */
	public static function esClusterTemplates(): array {
		return array_values(array_unique([Roles::clusterTemplate(), self::LEGACY_CLUSTER_TEMPLATE]));
	}

	/**
	 * Every template name that marks a host as a client's cluster host, in both generations:
	 * the Elasticsearch template for a cluster asked over HTTP, the jump host template for one
	 * asked through SSH. current() recognises a cluster host by any of them.
	 */
	public static function clusterHostTemplates(): array {
		return array_merge(self::esClusterTemplates(), [JumpTemplate::NAME, JumpTemplate::LEGACY_NAME]);
	}

	/**
	 * A host.get tag filter for a kind of host under either generation. The two names have to be
	 * OR'd by hand: unless its evaltype says otherwise, host.get wants every tag name it is given
	 * at once, so the default would have asked for a host carrying ep-kind and evp-kind both —
	 * none does, and the filter would have matched nothing at all.
	 */
	public static function kindFilter(string $kind): array {
		return [
			['tag' => self::TAG_PREFIX.'kind', 'value' => $kind, 'operator' => TAG_OPERATOR_EQUAL],
			['tag' => self::LEGACY_TAG_PREFIX.'kind', 'value' => $kind, 'operator' => TAG_OPERATOR_EQUAL]
		];
	}

	/**
	 * Every client's master host, under either generation: by the master template, or — when the
	 * templates cannot be read at all, as they cannot by a Zabbix Admin who may read only hosts —
	 * by the master host's own kind tag. $options is a host.get, less the selection made here.
	 *
	 * One definition, because two callers ask Zabbix the same question and a disagreement between
	 * them is what lets a host look unowned: ClientState::clients() lists the clients, and
	 * clientGroups() names their host groups for the guard that keeps one client's server out of
	 * another client's hands.
	 */
	public static function masterHosts(array $options): array {
		$tpl = API::Template()->get(['output' => ['templateid'], 'filter' => ['host' => self::masterTemplates()]]);
		if ($tpl) {
			return API::Host()->get(['templateids' => array_column($tpl, 'templateid')] + $options) ?: [];
		}
		return API::Host()->get(['tags' => self::kindFilter('master'), 'evaltype' => TAG_EVAL_TYPE_OR] + $options) ?: [];
	}

	/**
	 * Template ids by name: the client hosts' templates and `$extra` (the roles' in use). The log
	 * archive template is imported separately (it is not in this repository), so it is required only
	 * for a client that has a bucket — without it, a Zabbix with no log archive could add no client.
	 */
	public function templateIds(array $extra = [], bool $ulm = true): array {
		$names = array_values(array_unique(array_merge([MasterTemplate::NAME], self::clusterTemplates(), self::JUMP_CLUSTER_TEMPLATES,
			$ulm ? [self::ULM_TEMPLATE] : [], [JumpTemplate::ULM_NAME, self::agentTemplate()], $extra)));
		$found = array_column(API::Template()->get(['output' => ['templateid', 'host'], 'filter' => ['host' => $names]]), 'templateid', 'host');
		$missing = array_diff($names, array_keys($found));
		if ($missing) {
			throw new Exception(self::missingTemplatesMessage($missing));
		}
		return $found;
	}

	/**
	 * Why each missing template is missing, and what to do about it. One sentence per cause:
	 * "import the others first" sent an operator to the Clients page they had already used, and
	 * never said that the log archive template is not in this repository at all.
	 */
	public static function missingTemplatesMessage(array $missing): string {
		$written = [MasterTemplate::NAME, DevicesTemplate::NAME, JumpTemplate::NAME, JumpTemplate::ULM_NAME];
		$button = array_values(array_intersect($missing, $written));
		$archive = in_array(self::ULM_TEMPLATE, $missing, true);
		$import = array_values(array_diff($missing, $written, [self::ULM_TEMPLATE]));

		$out = [_s('Nothing was saved. These templates are not in Zabbix: %1$s.', implode(', ', $missing))];
		if ($archive) {
			$out[] = _s('"%1$s" is imported separately — it is not part of the module (see deploy/zabbix/README.md). To add this client without a log archive host, leave its S3 bucket empty; a DI client always needs one.', self::ULM_TEMPLATE);
		}
		if ($button) {
			$out[] = _('Write master template on the Clients page writes the rest of ours.');
		}
		if ($import) {
			$out[] = _s('Import first: %1$s.', implode(', ', $import));
		}
		return implode(' ', $out);
	}

	public function groupId(string $name, bool $create): ?string {
		if (isset($this->groupIds[$name])) {
			return $this->groupIds[$name];
		}
		$groups = API::HostGroup()->get(['output' => ['groupid'], 'filter' => ['name' => $name]]);
		if ($groups) {
			return $this->groupIds[$name] = $groups[0]['groupid'];
		}
		if (!$create) {
			return null;
		}
		$r = $this->api(API::HostGroup()->create(['name' => $name]), _s('create host group "%1$s"', $name));
		$this->done[] = _s('Created host group "%1$s".', $name);
		return $this->groupIds[$name] = $r['groupids'][0];
	}

	public function hostsIn(?string $groupid): array {
		if ($groupid === null) {
			return [];
		}
		return API::Host()->get([
			'output' => ['hostid', 'host', 'name', 'status', 'active_available', 'monitored_by', 'proxyid', 'proxy_groupid', 'inventory_mode', 'maintenance_status'],
			'groupids' => [$groupid],
			'selectHostGroups' => ['groupid', 'name'],
			'selectParentTemplates' => ['templateid', 'host'],
			'selectInterfaces' => ['interfaceid', 'ip', 'dns', 'type', 'main', 'available'],
			'selectTags' => ['tag', 'value'],
			'selectInventory' => ['notes'],
			'selectMacros' => ['macro', 'type'],
			'preservekeys' => true
		]);
	}

	/** Every role the client's servers hold. */
	private static function rolesIn(array $client): array {
		return array_values(array_unique(array_merge([], ...array_values(array_map(fn($s) => $s['roles'], $client['servers'])))));
	}

	/**
	 * Whether this page made the host, under either generation of the marker: a client saved
	 * before the rename is still this page's, and a host that is not recognised as managed is one
	 * the first save un-manages for good — after that remove() and a merge both refuse it.
	 */
	public static function isManaged(array $host): bool {
		foreach ($host['tags'] ?? [] as $tag) {
			foreach ([self::MANAGED, self::LEGACY_MANAGED] as $marker) {
				if ($tag['tag'] === $marker['tag'] && $tag['value'] === $marker['value']) {
					return true;
				}
			}
		}
		return false;
	}

	public static function hasTemplate(array $host, string $template): bool {
		return in_array($template, array_column($host['parentTemplates'] ?? [], 'host'), true);
	}

	/** Whether a host has any of these templates — one of ours under either of its names. */
	public static function hasAnyTemplate(array $host, array $templates): bool {
		return (bool) array_intersect($templates, array_column($host['parentTemplates'] ?? [], 'host'));
	}

	/**
	 * Whether this host already keeps the Elasticsearch password in Zabbix. Zabbix never gives a
	 * Secret text macro's value back through the API, to anyone, so no form can read the password
	 * to show it or to compare it: whether one is there is the only question that can be
	 * answered, and it is the question the edit form and problems() were each asking inline.
	 *
	 * Needs a host read with selectMacros. A Vault macro is deliberately not one of these: in
	 * vault mode the password is not in Zabbix at all, so switching such a client to zabbix mode
	 * does ask for it once.
	 */
	public static function hasStoredPassword(?array $host): bool {
		foreach ($host['macros'] ?? [] as $m) {
			if ($m['macro'] === self::ES_PASSWORD_MACRO && (int) $m['type'] === ZBX_MACRO_TYPE_SECRET) {
				return true;
			}
		}
		return false;
	}

	public static function groupNames(array $host): array {
		return array_column($host['hostgroups'] ?? [], 'name');
	}

	public static function agentIp(array $host): ?string {
		foreach ($host['interfaces'] ?? [] as $if) {
			if ($if['type'] == INTERFACE_TYPE_AGENT && $if['main'] == INTERFACE_PRIMARY && $if['ip'] !== '') {
				return $if['ip'];
			}
		}
		return null;
	}

	/**
	 * Tag values of one name on a host and, for one of this page's own tags, of its old spelling
	 * as well: the live Zabbix was never migrated, so its hosts carry evp-client where this page
	 * now writes ep-client, and a reader that looked only for the new name saw an unowned host
	 * with no roles.
	 */
	public static function tagValues(array $host, string $tag): array {
		$names = [$tag, self::legacyTag($tag)];
		return array_values(array_unique(array_map(fn($t) => $t['value'],
			array_filter($host['tags'] ?? [], fn($t) => in_array($t['tag'], $names, true)))));
	}

	/**
	 * What a host is by its ep-kind tag (or the evp-kind one a host from before the rename has),
	 * when it shows no templates at all — as it does to a Zabbix Admin who may read hosts but not
	 * templates. Otherwise null: templates decide.
	 */
	public static function kindWithoutTemplates(array $host): ?string {
		return empty($host['parentTemplates']) ? (self::tagValues($host, 'ep-kind')[0] ?? null) : null;
	}

	/**
	 * What exists for a client now: master, cluster and archive hosts, and its servers — each
	 * with its roles, services, notes and attributes read back, and per role. Servers without a
	 * role are `unassigned`; an IP more than one host has is in `shared`.
	 */
	public function current(string $client): array {
		$gid = $this->groupId($client, false);
		$hosts = $this->hostsIn($gid);
		$out = ['groupid' => $gid, 'master' => null, 'cluster' => null, 'ulm' => null, 'machines' => [], 'roles' => [], 'unassigned' => [], 'shared' => []];
		foreach ($hosts as $host) {
			if (self::hasAnyTemplate($host, self::masterTemplates()) || self::kindWithoutTemplates($host) === 'master') {
				$out['master'] = $host;
			}
			// Both generations, as the master host above and the log archive host below are read:
			// a pre-rename cluster host recognised as absent is the one failure that gets as far
			// as writing. apply() would take the create branch and ask for <client>-ES-Cluster,
			// a name the rename did not change, so Zabbix refuses the create — after the master
			// host has been retagged and relinked, which no rollback here can undo.
			elseif ($out['cluster'] === null && (self::hasAnyTemplate($host, self::clusterHostTemplates())
					|| self::kindWithoutTemplates($host) === 'cluster')) {
				$out['cluster'] = $host;
			}
		}
		foreach ($hosts as $host) {
			if (in_array($host['hostid'], [$out['master']['hostid'] ?? null, $out['cluster']['hostid'] ?? null], true)) {
				continue;
			}
			if ($out['ulm'] === null && (self::hasAnyTemplate($host, self::ulmTemplates()) || self::kindWithoutTemplates($host) === 'archive')) {
				$out['ulm'] = $host;
			}
		}
		foreach (Roles::allRoles($this->roles) as $r) {
			$out['roles'][$r['id']] = [];
		}
		$configGroups = Roles::groups($this->roles);
		$special = array_filter([$out['master']['hostid'] ?? null, $out['cluster']['hostid'] ?? null, $out['ulm']['hostid'] ?? null]);
		$byIp = [];
		foreach ($hosts as $host) {
			if (in_array($host['hostid'], $special, true)) {
				continue;
			}
			$groups = self::groupNames($host);
			if (!array_intersect($groups, $configGroups) && !in_array('server', self::tagValues($host, 'ep-kind'), true)) {
				continue;
			}
			$roles = Roles::rolesOfGroups($this->roles, $groups);
			// A viewer who sees no templates may not see the role groups either: the server's ep-role tags say the same.
			if (!$roles && empty($host['parentTemplates'])) {
				$byId = Roles::byId($this->roles);
				$roles = array_values(array_filter(array_map(fn($id) => $byId[$id] ?? null, self::tagValues($host, 'ep-role'))));
			}
			$roleIds = array_column($roles, 'id');
			$host['_roles'] = $roleIds;
			$host['_role'] = $roles[0] ?? null;
			$host['_ip'] = self::agentIp($host);
			$host['_services'] = array_values(array_diff(self::tagValues($host, 'ep-service'), $roleIds));
			$host['_notes'] = is_array($host['inventory'] ?? null) ? (string) ($host['inventory']['notes'] ?? '') : '';
			$host['_families'] = array_values(array_map(fn($f) => $f['id'], array_filter($this->roles['families'], fn($f) => in_array($f['group'], $groups, true))));
			$host['_attrs'] = [];
			foreach ($host['tags'] ?? [] as $t) {
				if (strpos($t['tag'], 'inv:') === 0) {
					$host['_attrs'][substr($t['tag'], 4)] = $t['value'];
				}
			}
			$out['machines'][$host['hostid']] = $host;
			foreach ($roleIds as $rid) {
				$out['roles'][$rid][] = $host;
			}
			if (!$roleIds) {
				$out['unassigned'][] = $host;
			}
			if ($host['_ip'] !== null) {
				$byIp[$host['_ip']][] = $host;
			}
		}
		foreach ($byIp as $ip => $list) {
			if (count($list) > 1) {
				usort($list, fn($a, $b) => (int) $a['hostid'] <=> (int) $b['hostid']);
				$out['shared'][$ip] = $list;
			}
		}
		// A master host outside the client's group, from before the group existed.
		if ($out['master'] === null) {
			foreach ([ClientSpec::masterName($client), $client.' master'] as $name) {
				$found = API::Host()->get(['output' => ['hostid', 'host', 'name'], 'filter' => ['host' => $name],
					'selectTags' => ['tag', 'value'], 'selectHostGroups' => ['groupid', 'name'], 'selectParentTemplates' => ['templateid', 'host']]);
				if ($found) {
					$out['master'] = $found[0];
					break;
				}
			}
		}
		return $out;
	}

	/**
	 * Host groups named after a client: every group a client's master host is in, but the masters'
	 * own — under either name, or the old masters' group would itself be read as a client called
	 * "ElasticVue clients" and every master host would look like one of its servers.
	 *
	 * This list is the guard that stops taking a host on from absorbing another client's server,
	 * so an empty one is not a safe answer: it goes through masterHosts(), which falls back to
	 * the kind tag when the templates cannot be read.
	 */
	public function clientGroups(): array {
		$out = [];
		foreach (self::masterHosts(['output' => ['hostid'], 'selectHostGroups' => ['name']]) as $h) {
			foreach ($h['hostgroups'] ?? [] as $g) {
				if ($g['name'] !== self::MASTERS_GROUP && $g['name'] !== self::LEGACY_MASTERS_GROUP) {
					$out[$g['name']] = true;
				}
			}
		}
		return array_keys($out);
	}

	/**
	 * Hosts outside this client with these IPs (on their agent interface): per IP, the ones free
	 * to take on, and the client that owns it when another does.
	 */
	public function outsiders(string $client, array $ips): array {
		$out = ['free' => [], 'taken' => []];
		if (!$ips) {
			return $out;
		}
		$ifs = API::HostInterface()->get(['output' => ['hostid', 'ip'], 'filter' => ['ip' => array_values($ips), 'type' => INTERFACE_TYPE_AGENT]]);
		if (!$ifs) {
			return $out;
		}
		$hosts = API::Host()->get([
			'output' => ['hostid', 'host', 'name', 'monitored_by', 'proxyid', 'proxy_groupid', 'inventory_mode'],
			'hostids' => array_values(array_unique(array_column($ifs, 'hostid'))),
			'selectHostGroups' => ['groupid', 'name'], 'selectTags' => ['tag', 'value'], 'selectParentTemplates' => ['templateid', 'host'],
			'selectInterfaces' => ['interfaceid', 'ip', 'dns', 'type', 'main', 'available'], 'selectInventory' => ['notes'], 'preservekeys' => true
		]);
		$clients = $this->clientGroups();
		foreach ($ifs as $if) {
			$h = $hosts[$if['hostid']] ?? null;
			if ($h === null) {
				continue;
			}
			$groups = self::groupNames($h);
			if (in_array($client, $groups, true)) {
				continue;
			}
			$owner = array_values(array_intersect($groups, $clients))[0] ?? (self::tagValues($h, 'ep-client')[0] ?? null);
			if ($owner !== null && $owner !== $client) {
				$out['taken'][$if['ip']] = ['client' => $owner, 'name' => $h['name']];
				continue;
			}
			$h['_ip'] = $if['ip'];
			$h['_roles'] = [];
			$h['_notes'] = is_array($h['inventory'] ?? null) ? (string) ($h['inventory']['notes'] ?? '') : '';
			$out['free'][$if['ip']][$h['hostid']] = $h;
		}
		return $out;
	}

	public function macros(string $hostid): array {
		return array_column(API::UserMacro()->get(['output' => ['macro', 'value'], 'hostids' => [$hostid]]), 'value', 'macro');
	}

	/* ------------------------------------ writing ------------------------------------ */

	/** Hosts sharing an IP in this client, without a ticked merge or with a hand-made one to delete. Pure. */
	public function sharedProblems(array $client, array $now): array {
		$out = [];
		foreach ($now['shared'] as $ip => $list) {
			if (!isset($client['servers'][$ip])) {
				continue;
			}
			$names = implode(', ', array_map(fn($h) => '"'.$h['name'].'"', $list));
			if (!in_array($ip, $client['merge'], true)) {
				$out[] = _s('%1$s hosts share %2$s (%3$s). Tick "merge" beside it to keep the first, with its history, and delete the others.', count($list), $ip, $names);
				continue;
			}
			foreach (array_slice($list, 1) as $h) {
				if (!self::isManaged($h)) {
					$out[] = _s('"%1$s" shares %2$s but was made by hand, so this page will not delete it. Remove it in Data collection → Hosts, then save again.', $h['name'], $ip);
				}
			}
		}
		return $out;
	}

	/**
	 * Every reason this client cannot be applied as it stands, found before anything is written:
	 * hosts sharing an IP without a confirmed merge, a password Zabbix does not have yet, a proxy
	 * that does not exist.
	 */
	public function problems(array $client, array $now): array {
		$out = $this->sharedProblems($client, $now);
		// Refuse before anything is written, not after. A master host that still carries the
		// pre-rename {$EVP.…} macros holds this client's real settings - requested CPU, memory
		// and disk per role, client type, jump-host fields, the lead and the cluster DL. Reading
		// them is handled elsewhere, but a gap anywhere in that chain means the form opened on
		// shipped defaults, and saving would write those defaults over the real values, record
		// the destroyed version as the backup, and have the alert routing conclude the client no
		// longer wants alerts and delete its action, DL group, DL account and weekly report.
		// None of that is recoverable from this module, so the save stops here and names what to
		// run instead. A false positive costs a refused save; a false negative costs the client.
		if (($now['master'] ?? null) !== null) {
			$legacy = ClientSpec::legacyMacrosIn($this->macros($now['master']['hostid']));
			if ($legacy) {
				$shown = array_slice($legacy, 0, 4);
				$out[] = _s('This client still stores its settings under the previous names (%1$s%2$s). '
					.'Saving now would overwrite them with defaults. Run the migration first: '
					.'python3 setup/zbx_rename.py --apply', implode(', ', $shown),
					count($legacy) > count($shown) ? _s(' and %1$d more', count($legacy) - count($shown)) : '');
			}
		}
		if ($client['es'] !== null && $client['fields']['es_password_mode'] === 'zabbix' && $client['es_password'] === '') {
			foreach ([['cluster', _('cluster')], ['ulm', _('log archive')]] as [$k, $label]) {
				if ($k === 'ulm' && !$this->spec->wantsUlm($client)) {
					continue;
				}
				if (!self::hasStoredPassword($now[$k])) {
					$out[] = _s('Enter the Elasticsearch password: the %1$s host has none kept in Zabbix yet.', $label);
				}
			}
		}
		// A server's IP is one client's only; a host elsewhere with it is taken on, if there is one.
		$inClient = array_filter(array_map(fn($h) => $h['_ip'], $now['machines']));
		$new = array_values(array_diff(array_keys($client['servers']), $inClient));
		$outside = $this->outsiders($client['name'], $new);
		foreach ($outside['taken'] as $ip => $t) {
			$out[] = _s('%1$s is already "%2$s", a server of client %3$s. An IP belongs to one client only.', $ip, $t['name'], $t['client']);
		}
		foreach ($outside['free'] as $ip => $list) {
			if (count($list) > 1) {
				$out[] = _s('%1$s hosts outside any client have %2$s (%3$s). Keep one — remove the others in Data collection → Hosts — then save again.',
					count($list), $ip, implode(', ', array_map(fn($h) => '"'.$h['name'].'"', $list)));
			}
		}
		try {
			$this->templateIds(Roles::templatesOf($this->roles, self::rolesIn($client)), $this->spec->wantsUlm($client));
		}
		catch (Exception $e) {
			$out[] = $e->getMessage();
		}
		try {
			$this->monitoredBy($client);
		}
		catch (Exception $e) {
			$out[] = $e->getMessage();
		}
		// The pre-flight: apply() has no transaction and no rollback, so a refusal it runs into
		// halfway through leaves the client half-written. Both of these ask Zabbix only.
		$out = array_merge($out, $this->nameClashes($client, $now), $this->legacyJumpClash($client, $now));
		return array_values(array_unique($out));
	}

	/**
	 * Names apply() would create that a host in Zabbix already has.
	 *
	 * This is the half-written save that was actually reached. The master, cluster and log
	 * archive hosts are named after the client — <client>-Master, <client>-ES-Cluster,
	 * <client>-ULM — and the rename did not change those names, so a client whose hosts
	 * current() fails to recognise still has them under exactly the names apply() would ask
	 * Zabbix to create. host.create is refused and api() throws; by then apply() has already
	 * renamed, relinked and retagged the master host and written its macros over the defaults
	 * the form was showing. Refusing before the first write costs the operator a message, and
	 * tells them which host to point this page at.
	 *
	 * Both the technical and the visible name are asked for, because create() gives a new host
	 * the same string for both and Zabbix refuses a collision on either.
	 *
	 * The servers are not covered: their names carry a number this page hands out
	 * (ClientSpec::machineName), and the number is chosen while applying.
	 */
	private function nameClashes(array $client, array $now): array {
		$wanted = [];
		if ($now['master'] === null) {
			$wanted[ClientSpec::masterName($client['name'])] = [_('master'), 'master'];
		}
		if ($client['es'] !== null && $now['cluster'] === null) {
			$wanted[ClientSpec::clusterName($client['name'])] = [_('cluster'), 'cluster'];
		}
		if ($this->spec->wantsUlm($client) && $now['ulm'] === null) {
			$wanted[ClientSpec::ulmName($client['name'])] = [_('log archive'), 'archive'];
		}
		if (!$wanted) {
			return [];
		}
		$names = array_keys($wanted);
		$found = [];
		foreach ([['host' => $names], ['name' => $names]] as $filter) {
			foreach (API::Host()->get(['output' => ['hostid', 'host', 'name'], 'filter' => $filter]) as $host) {
				$found[$host['hostid']] = $host;
			}
		}
		$out = [];
		foreach ($found as $host) {
			[$label, $kind] = $wanted[$host['host']] ?? $wanted[$host['name']] ?? [_('client'), ''];
			$out[] = _s('Nothing was saved. A host called "%1$s" already exists, but this page did not recognise it as the %2$s host of client "%3$s", so saving it would ask Zabbix to create that host a second time — and Zabbix would refuse, in the middle of the save, after the other hosts had been written. Put it in host group "%3$s" in Data collection → Hosts; if it is already there, give it the tag %4$s: %5$s so this page can tell what it is. Then save again.',
				$host['host'], $label, $client['name'], self::TAG_PREFIX.'kind', $kind);
		}
		return $out;
	}

	/**
	 * The one template collision that is certain, refused before anything is written: a cluster
	 * host still linked to the pre-rename jump host template, on a client that is asked through
	 * a jump host.
	 *
	 * Both generations of that template carry the same item keys on purpose — see
	 * JumpTemplate::LEGACY_NAME — so Zabbix will not let one host carry both, and apply() links
	 * the current one without unlinking the old one: it only knows how to unlink the current
	 * generation's other transport. The link is refused in the middle of the save, after the
	 * master host has been written.
	 *
	 * This page will not unlink it on the operator's behalf. Unlinking is the safe half of that
	 * operation, but which generation of items the host should keep afterwards, and whether the
	 * leftovers are disabled or cleared, is a decision about item history that nothing here can
	 * give back once it has been made wrongly; TemplateInstaller::legacyCollision() spells out
	 * the procedure. Refusing leaves the client exactly as it is.
	 */
	private function legacyJumpClash(array $client, array $now): array {
		// Asked of the HOST, not of the form. Whether this client is monitored through a jump
		// host is read from {$EP.MONITORED.BY}, which is unreadable on a host that still carries
		// the pre-rename macros - so throughJump() returns the shipped default and this guard
		// would stay silent in exactly the case it was written for: a legacy jump-host client
		// whose save then fails half way, after the master host has been written. The template
		// on the host is the fact that matters, and it is readable whatever the macros say.
		if ($now['cluster'] === null || !self::hasTemplate($now['cluster'], JumpTemplate::LEGACY_NAME)) {
			return [];
		}
		return [_s('Nothing was saved. "%1$s" is still linked to "%2$s", the jump host template from before the rename, whose item keys are the ones "%3$s" uses as well — Zabbix refuses to link both to one host, and it would refuse in the middle of the save, after the master host had been written. In Data collection → Hosts → "%1$s" → Templates, unlink "%2$s" — "Unlink", never "Unlink and clear", which deletes those items and every value they hold; unlinking leaves them on the host with their history, and the current template takes over the ones whose keys it shares. Then save again.',
			$now['cluster']['host'], JumpTemplate::LEGACY_NAME, JumpTemplate::NAME)];
	}

	/**
	 * The hosts saving this client would delete, with their history: servers this page made that
	 * are no longer listed, hosts merged away, and the log archive host when the bucket goes.
	 * A host without a role is never among them — it is left as it is.
	 */
	public function plannedDeletes(array $client, array $now): array {
		$out = [];
		foreach ($now['machines'] as $h) {
			if (!self::isManaged($h) || !$h['_roles'] || $h['_ip'] === null) {
				continue;
			}
			if (!isset($client['servers'][$h['_ip']])) {
				$out[$h['hostid']] = $h['name'];
			}
		}
		foreach ($now['shared'] as $ip => $list) {
			if (isset($client['servers'][$ip]) && in_array($ip, $client['merge'], true)) {
				foreach (array_slice($list, 1) as $h) {
					if (self::isManaged($h)) {
						$out[$h['hostid']] = $h['name'];
					}
				}
			}
		}
		if (!$this->spec->wantsUlm($client) && $now['ulm'] !== null && self::isManaged($now['ulm'])) {
			$out[$now['ulm']['hostid']] = $now['ulm']['name'];
		}
		return $out;
	}

	/** Make Zabbix match the client. Throws, with what Zabbix said, at the first refusal. */
	public function apply(array $client): void {
		$tpl = $this->templateIds(Roles::templatesOf($this->roles, self::rolesIn($client)), $this->spec->wantsUlm($client));
		$name = $client['name'];
		$now = $this->current($name);
		$problems = $this->problems($client, $now);
		if ($problems) {
			throw new Exception(implode(' ', $problems));
		}
		$monitor = $this->monitoredBy($client);
		$gid = $now['groupid'] ?? $this->groupId($name, true);
		// A disabled or decommissioned client's new hosts start not monitored, like the rest of it.
		$this->status = $now['master'] !== null ? Lifecycle::statusOf($this->macros($now['master']['hostid'])) : 'active';

		// Master host: the client's figures, alerts and dashboard. Calculated items only, so the
		// Zabbix server keeps it whatever the proxy.
		$masters_gid = $this->groupId(self::MASTERS_GROUP, true);
		if ($now['master'] === null) {
			$hostid = $this->create(['host' => ClientSpec::masterName($name), 'groups' => $this->g([$masters_gid, $gid]),
				'templates' => $this->t([$tpl[MasterTemplate::NAME]]), 'tags' => $this->tags([], $name, 'master', true)]);
			$this->done[] = _s('Created "%1$s".', ClientSpec::masterName($name));
		}
		else {
			$hostid = $now['master']['hostid'];
			$this->rename($now['master'], ClientSpec::masterName($name));
			$this->link($hostid, [$tpl[MasterTemplate::NAME]], [$masters_gid, $gid]);
			$this->retag($now['master'], $this->tags($now['master']['tags'] ?? [], $name, 'master', self::isManaged($now['master'])));
		}
		$this->setMacros($hostid, $this->spec->masterMacros($client));

		// Cluster host, when there is an ES URL: asked over HTTP, or through the jump host.
		if ($client['es'] !== null) {
			$jump = $this->spec->throughJump($client);
			$cluster = self::clusterTemplates();
			$templates = array_map(fn($x) => $tpl[$x], $jump ? self::JUMP_CLUSTER_TEMPLATES : $cluster);
			// The other way's templates, unlinked (not cleared) on a switch: items of the keys both
			// share keep their history when the new template takes them over.
			$other = array_map(fn($x) => $tpl[$x], array_diff($jump ? $cluster : self::JUMP_CLUSTER_TEMPLATES,
				$jump ? self::JUMP_CLUSTER_TEMPLATES : $cluster));
			$groups = [$gid, $this->groupId(self::CLUSTER_GROUP, true)];
			if ($now['cluster'] === null) {
				$hostid = $this->create(['host' => ClientSpec::clusterName($name), 'groups' => $this->g($groups), 'templates' => $this->t($templates),
					// The Elasticsearch template's port checks need an interface to exist.
					'interfaces' => [['type' => INTERFACE_TYPE_AGENT, 'main' => INTERFACE_PRIMARY, 'useip' => INTERFACE_USE_DNS,
						'ip' => '', 'dns' => $client['es']['host'], 'port' => '10050']],
					'tags' => $this->tags([], $name, 'cluster', true)] + $monitor);
				$this->setMacros($hostid, $this->spec->clusterMacros($client, true));
				$this->done[] = _s('Created "%1$s".', ClientSpec::clusterName($name));
			}
			else {
				$this->rename($now['cluster'], ClientSpec::clusterName($name));
				$linked = array_column($now['cluster']['parentTemplates'] ?? [], 'templateid');
				$drop = array_values(array_intersect($other, $linked));
				if ($drop) {
					$this->api(API::Host()->massRemove(['hostids' => [$now['cluster']['hostid']], 'templateids' => $drop]), _('unlink the other cluster templates'));
					$this->done[] = $jump ? _('The cluster is now asked through the jump host.') : _('The cluster is now asked over HTTP.');
				}
				$this->link($now['cluster']['hostid'], $templates, $groups);
				$this->monitor($now['cluster'], $monitor);
				$this->retag($now['cluster'], $this->tags($now['cluster']['tags'] ?? [], $name, 'cluster', self::isManaged($now['cluster'])));
				$this->setMacros($now['cluster']['hostid'], $this->spec->clusterMacros($client, false));
			}
		}

		// Log archive host, when there is a bucket; removed when there no longer is one.
		if ($this->spec->wantsUlm($client)) {
			$groups = [$gid, $this->groupId(self::ULM_GROUP, true)];
			$jumpUlm = $this->spec->throughJump($client) && isset($tpl[JumpTemplate::ULM_NAME]);
			$ulmTpls = array_merge([$tpl[self::ULM_TEMPLATE]], $jumpUlm ? [$tpl[JumpTemplate::ULM_NAME]] : []);
			if ($now['ulm'] === null) {
				$hostid = $this->create(['host' => ClientSpec::ulmName($name), 'groups' => $this->g($groups),
					'templates' => $this->t($ulmTpls), 'tags' => $this->tags([], $name, 'archive', true)] + $monitor);
				$this->setMacros($hostid, $this->spec->ulmMacros($client, true));
				$this->done[] = _s('Created "%1$s".', ClientSpec::ulmName($name));
			}
			else {
				$this->rename($now['ulm'], ClientSpec::ulmName($name));
				$this->link($now['ulm']['hostid'], $ulmTpls, $groups);
				// Back to direct: the SSH items go with the template (cleared: nothing else reads them).
				if (!$jumpUlm && isset($tpl[JumpTemplate::ULM_NAME]) && self::hasTemplate($now['ulm'], JumpTemplate::ULM_NAME)) {
					$this->api(API::Host()->massRemove(['hostids' => [$now['ulm']['hostid']], 'templateids_clear' => [$tpl[JumpTemplate::ULM_NAME]]]), _('unlink the jump host log archive template'));
				}
				$this->monitor($now['ulm'], $monitor);
				$this->retag($now['ulm'], $this->tags($now['ulm']['tags'] ?? [], $name, 'archive', self::isManaged($now['ulm'])));
				$this->setMacros($now['ulm']['hostid'], $this->spec->ulmMacros($client, false));
			}
		}
		elseif ($now['ulm'] !== null && self::isManaged($now['ulm'])) {
			$this->delete([$now['ulm']]);
		}

		$this->servers($client, $now, $gid, $tpl, $monitor);
	}

	/** The servers, matched by IP across the whole client. */
	private function servers(array $client, array $now, string $gid, array $tpl, array $monitor): void {
		$name = $client['name'];
		$config_groups = Roles::groups($this->roles);
		$byId = Roles::byId($this->roles);
		$byIp = [];
		$merged = [];
		foreach ($now['machines'] as $host) {
			if ($host['_ip'] === null) {
				continue;
			}
			if (isset($now['shared'][$host['_ip']])) {
				// Merging keeps the oldest host; the others go (problems() made sure they may).
				$keep = $now['shared'][$host['_ip']][0];
				if ($host['hostid'] !== $keep['hostid']) {
					if (isset($client['servers'][$host['_ip']])) {
						$merged[$host['hostid']] = $host;
					}
					continue;
				}
			}
			$byIp[$host['_ip']] = $host;
		}
		// Hosts elsewhere in Zabbix with a new server's IP, belonging to no client: taken on.
		// problems() made sure there is at most one per IP and none of another client's.
		$adopted = [];
		foreach ($this->outsiders($name, array_values(array_diff(array_keys($client['servers']), array_keys($byIp))))['free'] as $ip => $list) {
			$byIp[$ip] = reset($list);
			$adopted[$byIp[$ip]['hostid']] = true;
		}
		// Numbers already in use per name pattern — names that follow it keep theirs.
		$taken = [];
		foreach ($now['machines'] as $host) {
			if (preg_match('/^'.preg_quote($name, '/').'-(.+)-(\d+)$/', $host['host'], $m) && (int) $m[2] > 0) {
				$taken[$m[1]][(int) $m[2]] = true;
			}
		}
		$next = function(string $base) use (&$taken): int {
			$n = !empty($taken[$base]) ? max(array_keys($taken[$base])) + 1 : 1;
			$taken[$base][$n] = true;
			return $n;
		};
		$port = $client['fields']['agent_port'] !== '' ? $client['fields']['agent_port'] : '10050';

		$kept = [];
		foreach ($client['servers'] as $ip => $s) {
			$base = Roles::serverBase($this->roles, $s['roles']);
			$want = array_merge(array_map(fn($rid) => $byId[$rid]['group'], $s['roles']), Roles::familyGroupsOf($this->roles, $s['roles']));
			$want_ids = array_merge([$gid], array_map(fn($g) => $this->groupId($g, true), array_unique($want)));
			$want_tpl = array_map(fn($t) => $tpl[$t], Roles::templatesOf($this->roles, $s['roles']));

			if (isset($byIp[$ip])) {
				$host = $byIp[$ip];
				$kept[$host['hostid']] = true;
				if (isset($adopted[$host['hostid']])) {
					$this->done[] = _s('Took on the existing host "%1$s" (%2$s): its history and templates stay.', $host['name'], $ip);
				}
				if (ClientSpec::slotOf($host['host'], $name, $base) === null) {
					$this->rename($host, ClientSpec::machineName($name, $base, $next($base)));
				}
				// Out of the groups of roles and families it no longer has; into the ones it has.
				$drop = [];
				foreach ($host['hostgroups'] as $g) {
					if (in_array($g['name'], $config_groups, true) && !in_array($g['name'], $want, true)) {
						$drop[] = $g['groupid'];
					}
				}
				if ($drop) {
					$this->api(API::Host()->massRemove(['hostids' => [$host['hostid']], 'groupids' => $drop]), _('move between role groups'));
				}
				$this->link($host['hostid'], $want_tpl, $want_ids);
				$this->monitor($host, $monitor);
				$this->retag($host, $this->serverTags($host['tags'] ?? [], $name, $s, self::isManaged($host)));
				$this->notes($host, $s['notes']);
				$this->setMacros($host['hostid'], ['{$GRP.CLIENT}' => [$name, 0]]);
				continue;
			}
			$host_name = ClientSpec::machineName($name, $base, $next($base));
			$new = [
				'host' => $host_name, 'groups' => $this->g($want_ids), 'templates' => $this->t($want_tpl),
				'interfaces' => [['type' => INTERFACE_TYPE_AGENT, 'main' => INTERFACE_PRIMARY, 'useip' => INTERFACE_USE_IP,
					'ip' => $ip, 'dns' => '', 'port' => $port]],
				'tags' => $this->serverTags([], $name, $s, true),
				'inventory_mode' => HOST_INVENTORY_AUTOMATIC
			] + $monitor;
			if ($s['notes'] !== '') {
				$new['inventory'] = ['notes' => $s['notes']];
			}
			$hostid = $this->create($new);
			$this->setMacros($hostid, ['{$GRP.CLIENT}' => [$name, 0]]);
			$kept[$hostid] = true;
			$this->done[] = _s('Created "%1$s" (%2$s).', $host_name, $ip);
		}
		if ($merged) {
			$this->delete($merged);
			$this->done[] = _s('Merged hosts that shared an IP: %1$s deleted, the first of each kept.', count($merged));
		}
		// No longer listed: deleted if this page made it and it held a role here; a host with no
		// role (never shown as a server) and one made by hand are left as they are.
		$gone = array_filter($now['machines'], fn($h) => !isset($kept[$h['hostid']]) && !isset($merged[$h['hostid']]));
		$this->delete(array_filter($gone, fn($h) => self::isManaged($h) && $h['_roles']));
		foreach (array_filter($gone, fn($h) => !self::isManaged($h) || !$h['_roles']) as $host) {
			$this->done[] = $host['_roles']
				? _s('"%1$s" was made by hand and is left as it is — add its IP as a server to take it on, or remove it in Data collection → Hosts.', $host['name'])
				: _s('"%1$s" has no role and is left as it is — give its IP a role to take it on.', $host['name']);
		}
	}

	/** Remove a client: every host this page made for it. Hosts made by hand and the host group stay. */
	public function remove(string $client): void {
		$now = $this->current($client);
		$all = [];
		foreach (array_merge(array_filter([$now['master'], $now['cluster'], $now['ulm']]), array_values($now['machines'])) as $h) {
			$all[$h['hostid']] = $h;
		}
		$this->delete(array_filter($all, [self::class, 'isManaged']));
		foreach (array_filter($all, fn($h) => !self::isManaged($h)) as $host) {
			$this->done[] = _s('"%1$s" was made by hand and is kept.', $host['name']);
		}
	}

	/* ------------------------------------ helpers ------------------------------------ */

	/** The host fields for the client's proxy: monitored_by and the proxy or group id. */
	private function monitoredBy(array $client): array {
		[$kind, $target] = ClientSpec::monitoredBy($client['fields']['monitored_by']) ?? ['server', ''];
		if ($kind === 'proxy') {
			$p = API::Proxy()->get(['output' => ['proxyid'], 'filter' => ['name' => $target]]);
			if (!$p) {
				throw new Exception(_s('There is no Zabbix proxy "%1$s".', $target));
			}
			return ['monitored_by' => ZBX_MONITORED_BY_PROXY, 'proxyid' => $p[0]['proxyid']];
		}
		if ($kind === 'group') {
			$p = API::ProxyGroup()->get(['output' => ['proxy_groupid'], 'filter' => ['name' => $target]]);
			if (!$p) {
				throw new Exception(_s('There is no Zabbix proxy group "%1$s".', $target));
			}
			return ['monitored_by' => ZBX_MONITORED_BY_PROXY_GROUP, 'proxy_groupid' => $p[0]['proxy_groupid']];
		}
		return ['monitored_by' => ZBX_MONITORED_BY_SERVER];
	}

	private function monitor(array $host, array $monitor): void {
		$same = (string) ($host['monitored_by'] ?? '') === (string) $monitor['monitored_by']
			&& (!isset($monitor['proxyid']) || (string) ($host['proxyid'] ?? '') === (string) $monitor['proxyid'])
			&& (!isset($monitor['proxy_groupid']) || (string) ($host['proxy_groupid'] ?? '') === (string) $monitor['proxy_groupid']);
		if (!$same) {
			$this->api(API::Host()->update(['hostid' => $host['hostid']] + $monitor), _s('change who monitors "%1$s"', $host['name']));
		}
	}

	private function g(array $ids): array {
		return array_map(fn($id) => ['groupid' => $id], array_values(array_unique($ids)));
	}

	private function t(array $ids): array {
		return array_map(fn($id) => ['templateid' => $id], array_values(array_unique($ids)));
	}

	/**
	 * Every spelling of the tags this page owns: the names it writes and, for each, the old
	 * generation's. tags() takes them all off and writes the current ones back, so a client made
	 * before the rename ends up with one ep-kind rather than an ep-kind beside its evp-kind.
	 */
	private static function ownTags(): array {
		$out = self::OWN_TAGS;
		foreach (self::OWN_TAGS as $tag) {
			if (self::legacyTag($tag) !== $tag) {
				$out[] = self::legacyTag($tag);
			}
		}
		// Nothing is added beyond the two spellings of OWN_TAGS: see the note beside OWN_TAGS on
		// why the already-off marker is Lifecycle's and must not be stripped here.
		return array_values(array_unique($out));
	}

	/**
	 * A host's tags with this page's replaced: the others it has stay. A host recognised as this
	 * page's under either generation comes out carrying managed-by: elasticpro-clients — $managed
	 * is isManaged(), which matches the old marker too, and the old marker is dropped here with
	 * the new one because both go by the same tag name. A host made by hand still gets none.
	 */
	private function tags(array $have, string $client, string $kind, bool $managed): array {
		// inv: tags belong to Host Inventory: kept, whoever set them.
		$own = self::ownTags();
		$out = array_values(array_filter($have, fn($t) => !in_array($t['tag'], $own, true) && !($t['tag'] === self::MANAGED['tag'])));
		if ($managed) {
			$out[] = self::MANAGED;
		}
		$out[] = ['tag' => 'ep-client', 'value' => $client];
		$out[] = ['tag' => 'ep-kind', 'value' => $kind];
		$out[] = ['tag' => 'ep-status', 'value' => $this->status];
		return array_map(fn($t) => ['tag' => $t['tag'], 'value' => $t['value']], $out);
	}

	/** A server's tags: kind, one ep-role per role, one ep-service per role or service, inv:<name> per attribute. */
	private function serverTags(array $have, string $client, array $s, bool $managed): array {
		// The attributes given here replace those inv: tags; every other inv: tag stays (Host Inventory's).
		$out = array_values(array_filter($this->tags($have, $client, 'server', $managed),
			fn($t) => strpos($t['tag'], 'inv:') !== 0 || !array_key_exists(substr($t['tag'], 4), $s['attrs'])));
		foreach ($s['roles'] as $rid) {
			$out[] = ['tag' => 'ep-role', 'value' => $rid];
		}
		foreach (array_merge($s['roles'], $s['services']) as $svc) {
			$out[] = ['tag' => 'ep-service', 'value' => $svc];
		}
		foreach ($s['attrs'] as $k => $v) {
			if ((string) $v !== '') {
				$out[] = ['tag' => 'inv:'.$k, 'value' => $v];
			}
		}
		return $out;
	}

	private function retag(array $host, array $want): void {
		$norm = function (array $tags): array {
			$x = array_map(fn($t) => $t['tag']."\0".$t['value'], $tags);
			sort($x);
			return $x;
		};
		if ($norm($host['tags'] ?? []) !== $norm($want)) {
			$this->api(API::Host()->update(['hostid' => $host['hostid'], 'tags' => $want]), _s('update the tags of "%1$s"', $host['name']));
		}
	}

	/** A server's notes into its inventory — where the host keeps one. */
	private function notes(array $host, string $notes): void {
		if ((string) ($host['_notes'] ?? '') === $notes) {
			return;
		}
		if ((int) ($host['inventory_mode'] ?? HOST_INVENTORY_DISABLED) === HOST_INVENTORY_DISABLED) {
			if (self::isManaged($host)) {
				$this->api(API::Host()->update(['hostid' => $host['hostid'], 'inventory_mode' => HOST_INVENTORY_AUTOMATIC,
					'inventory' => ['notes' => $notes]]), _('write notes'));
			}
			else {
				$this->done[] = _s('"%1$s" keeps no inventory, so its notes were not written. Turn its inventory on in Data collection → Hosts.', $host['name']);
			}
			return;
		}
		$this->api(API::Host()->update(['hostid' => $host['hostid'], 'inventory' => ['notes' => $notes]]), _('write notes'));
	}

	private function create(array $host): string {
		$host['name'] = $host['host'];
		if ($this->status !== 'active') {
			$host['status'] = HOST_STATUS_NOT_MONITORED;
		}
		return $this->api(API::Host()->create($host), _s('create host "%1$s"', $host['host']))['hostids'][0];
	}

	/** Give a host the client's name for it. History, items and links stay with the host. */
	private function rename(array $host, string $to): void {
		if ($host['host'] === $to && ($host['name'] ?? $to) === $to) {
			return;
		}
		$this->api(API::Host()->update(['hostid' => $host['hostid'], 'host' => $to, 'name' => $to]), _s('rename "%1$s"', $host['host']));
		$this->done[] = _s('Renamed "%1$s" to "%2$s".', $host['host'], $to);
	}

	/** Add templates and groups a host lacks. Nothing it has is taken away. */
	private function link(string $hostid, array $templateids, array $groupids): void {
		$this->api(API::Host()->massAdd(['hosts' => [['hostid' => $hostid]], 'templates' => $this->t($templateids), 'groups' => $this->g($groupids)]),
			_('link templates and groups'));
	}

	/**
	 * Write these macros, one by one; every other macro on the host stays as it is. A secret is
	 * written whenever it is given (Zabbix never shows it back to compare).
	 */
	private function setMacros(string $hostid, array $want): void {
		$have = [];
		foreach (API::UserMacro()->get(['output' => ['hostmacroid', 'macro', 'value', 'type'], 'hostids' => [$hostid]]) as $m) {
			$have[$m['macro']] = $m;
		}
		$create = [];
		foreach ($want as $macro => [$value, $type]) {
			if (!array_key_exists($macro, $have)) {
				$create[] = ['hostid' => $hostid, 'macro' => $macro, 'value' => (string) $value, 'type' => $type];
			}
			elseif ($have[$macro]['type'] != $type || $type == ZBX_MACRO_TYPE_SECRET || $have[$macro]['value'] !== (string) $value) {
				$this->api(API::UserMacro()->update(['hostmacroid' => $have[$macro]['hostmacroid'], 'value' => (string) $value, 'type' => $type]),
					_s('update macro %1$s', $macro));
			}
		}
		if ($create) {
			$this->api(API::UserMacro()->create($create), _('create macros'));
		}
	}

	private function delete(array $hosts): void {
		if (!$hosts) {
			return;
		}
		$this->api(API::Host()->delete(array_values(array_column($hosts, 'hostid'))), _('delete hosts'));
		foreach ($hosts as $host) {
			$this->done[] = _s('Deleted "%1$s".', $host['name']);
		}
	}

	private function api($result, string $what) {
		if ($result === false) {
			$said = array_column(get_and_clear_messages(), 'message');
			throw new Exception(_s('Zabbix would not %1$s: %2$s', $what, implode(' ', $said) ?: _('no reason given')));
		}
		return $result;
	}
}
