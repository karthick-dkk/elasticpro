<?php declare(strict_types = 0);

namespace Modules\EpVolume\Lib;

/**
 * Families and roles — the kinds of machine a client has.
 *
 * A family (ES, Parser, Forwarder, Engine) has a host group every one of its machines joins —
 * the groups the cluster and Linux templates count — and holds roles (ES Data Hot, S3 Parser,
 * UEBA …), each with its own host group and its own name part in host names: karthi-ES-Data-Hot-1.
 *
 * A server may hold several roles: it joins every one of their groups, and its name joins their
 * name parts (karthi-ES-Data-Parser-Engine-1). A role may also count in other families
 * (`alsoIn`): Single node is one role for an all-in-one server, and its machines count toward
 * ES, Parser, Forwarder and Engine.
 *
 * Kept in the data folder as roles.json; the defaults below are what a first start writes.
 * Everything that knows about machines reads this: the Clients page and its CSV, the master
 * template it generates, and the Client resources report.
 *
 * Copied from ../../shared/php by ../../sync-assets.mjs — edit it there.
 */
class Roles {

	public const FILE = 'roles.json';

	/** Ids that would collide with the master template's other item keys. */
	public const RESERVED = ['delay', 'role', 'storage', 'master', 'client', 'cluster', 'ulm'];

	public const RESOURCES = ['servers', 'cpu', 'mem', 'disk'];

	/** Template names an operator may point elsewhere; see templateNames(). */
	public const TEMPLATES_FILE = 'templates.json';

	/** The template a server gets when its roles name none. */
	public const DEFAULT_TEMPLATE = 'Linux by Zabbix agent -EP';

	/** The Elasticsearch template the cluster host is linked to. */
	public const DEFAULT_CLUSTER_TEMPLATE = 'Elasticsearch Cluster by HTTP EP';

	/** Disks per role: / always, and up to four more mounts (an ES data disk …). */
	public const DISK_SLOTS = 5;

	public static function defaults(): array {
		return ['version' => 2, 'families' => [
			['id' => 'es', 'label' => 'ES', 'group' => 'ESNodes', 'macroPrefix' => 'ES', 'memAlias' => 'ES.MEM.REQUESTED',
				'order' => ['servers', 'cpu', 'mem', 'disk'], 'roles' => [
				['id' => 'es_data', 'label' => 'ES Data', 'short' => 'ES-Data', 'group' => 'ES Data'],
				['id' => 'es_data_hot', 'label' => 'ES Data Hot', 'short' => 'ES-Data-Hot', 'group' => 'ES Data Hot'],
				['id' => 'es_data_warm', 'label' => 'ES Data Warm', 'short' => 'ES-Data-Warm', 'group' => 'ES Data Warm'],
				['id' => 'es_coord', 'label' => 'ES Coordination', 'short' => 'ES-Coord', 'group' => 'ES Coordination'],
				['id' => 'es_master', 'label' => 'ES Master', 'short' => 'ES-Master', 'group' => 'ES Master']
			]],
			['id' => 'parser', 'label' => 'Parser', 'group' => 'Parsers', 'macroPrefix' => 'PARSER', 'memAlias' => 'PARSER.MEM.REQUESTED',
				'order' => ['servers', 'cpu', 'mem', 'disk'], 'roles' => [
				['id' => 'parser', 'label' => 'Parser', 'short' => 'Parser', 'group' => 'Parser'],
				['id' => 's3_parser', 'label' => 'S3 Parser', 'short' => 'S3-Parser', 'group' => 'S3 Parser']
			]],
			// Memory before CPU, as the original capacity list had it.
			['id' => 'fwd', 'label' => 'Forwarder', 'group' => 'Forwarders', 'macroPrefix' => 'FWD', 'memAlias' => 'FORWARDER.MEM.REQUESTED',
				'order' => ['servers', 'mem', 'cpu', 'disk'], 'roles' => [
				['id' => 'forwarder', 'label' => 'Forwarder', 'short' => 'Forwarder', 'group' => 'Forwarders']
			]],
			['id' => 'engine', 'label' => 'Engine', 'group' => 'Engines', 'macroPrefix' => 'ENGINE', 'memAlias' => 'ENGINE.MEM.REQUESTED',
				'order' => ['servers', 'cpu', 'mem', 'disk'], 'roles' => [
				['id' => 'engine', 'label' => 'Engine', 'short' => 'Engine', 'group' => 'Engine'],
				['id' => 'ueba', 'label' => 'UEBA', 'short' => 'UEBA', 'group' => 'UEBA'],
				['id' => 'aiml', 'label' => 'AIML', 'short' => 'AIML', 'group' => 'AIML']
			]],
			// One role for an all-in-one server; it counts in each family it stands for.
			['id' => 'single', 'label' => 'Single node', 'group' => 'Single node', 'macroPrefix' => 'SINGLE', 'memAlias' => '',
				'order' => ['servers', 'cpu', 'mem', 'disk'], 'roles' => [
				['id' => 'single_node', 'label' => 'Single node', 'short' => 'Single-Node', 'group' => 'Single node',
					'alsoIn' => ['es', 'parser', 'fwd', 'engine'], 'exclusive' => true]
			]]
		]];
	}

	public static function load(): array {
		$config = Store::read(self::FILE);
		return is_array($config) && !empty($config['families']) ? self::upgrade($config) : self::defaults();
	}

	/**
	 * Roles saved by an older version, brought up to this one: the roles and families added
	 * since are put in where they belong, and nothing already there is changed or removed.
	 */
	public static function upgrade(array $config): array {
		// A file saved before the macro prefix had this name carries no macroPrefix; the prefix
		// is then the family's id in capitals, which is what every family shipped with has. A
		// family added by hand with a prefix unlike its id is corrected in roles.json.
		// By index, not `as &$family`: `$config['families'] ?? []` is a temporary, so a
		// by-reference loop over it writes into a copy and the migration silently does nothing.
		foreach (array_keys($config['families'] ?? []) as $i) {
			if (trim((string) ($config['families'][$i]['macroPrefix'] ?? '')) === '') {
				$config['families'][$i]['macroPrefix'] = strtoupper((string) ($config['families'][$i]['id'] ?? ''));
			}
		}
		if ((int) ($config['version'] ?? 1) >= 2) {
			return $config;
		}
		$original = $config;
		$have = [];
		foreach (self::allRoles($config) as $r) {
			$have[$r['id']] = true;
		}
		$families = array_column($config['families'], null, 'id');
		foreach (self::defaults()['families'] as $df) {
			if (!isset($families[$df['id']])) {
				$ids = array_column($df['roles'], 'id');
				if (!array_intersect($ids, array_keys($have))) {
					$config['families'][] = $df;
				}
				continue;
			}
			foreach ($config['families'] as &$f) {
				if ($f['id'] !== $df['id']) {
					continue;
				}
				foreach ($df['roles'] as $i => $dr) {
					if (!isset($have[$dr['id']])) {
						array_splice($f['roles'], min($i, count($f['roles'])), 0, [$dr]);
						$have[$dr['id']] = true;
					}
				}
			}
			unset($f);
		}
		$config['version'] = 2;
		// A name the added roles would clash with (a role already called "Engine" in host names):
		// keep the roles as they are rather than half-upgrade them.
		return self::validate($config) ? $original : $config;
	}

	public static function save(array $config): void {
		$errors = self::validate($config);
		if ($errors) {
			throw new \InvalidArgumentException(implode(' ', $errors));
		}
		Store::write(self::FILE, $config);
	}

	/** Every problem with a configuration, in words. Empty when it is usable. */
	public static function validate(array $config): array {
		$errors = [];
		// Families and roles have their own ids: a family's figures are ep.<id>.*, a role's
		// ep.role.*[<id>], so a family and a role may share a name (Parser, Parser).
		$familyIds = [];
		$roleIds = [];
		$shorts = [];
		$alsoIn = [];
		foreach ($config['families'] ?? [] as $f) {
			foreach (['id', 'label', 'group', 'macroPrefix'] as $k) {
				if (trim((string) ($f[$k] ?? '')) === '') {
					$errors[] = sprintf('A family has no %s.', $k);
				}
			}
			self::checkId((string) ($f['id'] ?? ''), $familyIds, $errors);
			if (!preg_match('/^[A-Z0-9_]{1,32}$/', (string) ($f['macroPrefix'] ?? ''))) {
				$errors[] = sprintf('Family "%s": the macro prefix may hold only A-Z, 0-9 and _.', $f['label'] ?? '?');
			}
			if (empty($f['roles'])) {
				$errors[] = sprintf('Family "%s" needs at least one role.', $f['label'] ?? '?');
			}
			foreach ($f['roles'] ?? [] as $r) {
				foreach (['id', 'label', 'short', 'group'] as $k) {
					if (trim((string) ($r[$k] ?? '')) === '') {
						$errors[] = sprintf('A role of "%s" has no %s.', $f['label'] ?? '?', $k);
					}
				}
				self::checkId((string) ($r['id'] ?? ''), $roleIds, $errors);
				$short = (string) ($r['short'] ?? '');
				if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9\-]{0,31}$/', $short)) {
					$errors[] = sprintf('Role "%s": the name in host names may hold only letters, digits and dashes.', $r['label'] ?? '?');
				}
				if (isset($shorts[strtolower($short)])) {
					$errors[] = sprintf('Two roles are called "%s" in host names.', $short);
				}
				$shorts[strtolower($short)] = true;
				$alsoIn[$r['label'] ?? '?'] = (array) ($r['alsoIn'] ?? []);
				foreach ((array) ($r['templates'] ?? []) as $t) {
					if (!is_string($t) || trim($t) === '' || strlen($t) > 128) {
						$errors[] = sprintf('Role "%s": a template name is empty or too long.', $r['label'] ?? '?');
					}
				}
			}
		}
		foreach ($alsoIn as $label => $fams) {
			foreach ($fams as $fid) {
				if (!isset($familyIds[$fid])) {
					$errors[] = sprintf('Role "%s" counts in family "%s", which does not exist.', $label, $fid);
				}
			}
		}
		if (empty($config['families'])) {
			$errors[] = 'There must be at least one family.';
		}
		return $errors;
	}

	private static function checkId(string $id, array &$ids, array &$errors): void {
		if (!preg_match('/^[a-z][a-z0-9_]{0,31}$/', $id)) {
			$errors[] = sprintf('"%s" is not a usable id: lower-case letters, digits and _, starting with a letter.', $id);
		}
		elseif (in_array($id, self::RESERVED, true)) {
			$errors[] = sprintf('"%s" is reserved; choose another id.', $id);
		}
		elseif (isset($ids[$id])) {
			$errors[] = sprintf('The id "%s" is used twice.', $id);
		}
		$ids[$id] = true;
	}

	/** Every role, in order, each with its family's id, label and group attached. */
	public static function allRoles(array $config): array {
		$out = [];
		foreach ($config['families'] as $f) {
			foreach ($f['roles'] as $r) {
				$out[] = $r + ['family' => $f['id'], 'familyLabel' => $f['label'], 'familyGroup' => $f['group']];
			}
		}
		return $out;
	}

	/** Every role by id, family attached. */
	public static function byId(array $config): array {
		return array_column(self::allRoles($config), null, 'id');
	}

	/** The families a role counts in: its own, then any it also stands for. */
	public static function familiesOf(array $role): array {
		return array_values(array_unique(array_merge([$role['family']], (array) ($role['alsoIn'] ?? []))));
	}

	/**
	 * The name part of a server holding these roles: each role's own, in role order, with a
	 * family word already written not repeated — ES Data Hot + ES Coordination is
	 * ES-Data-Hot-Coord; ES Data + Parser + Engine is ES-Data-Parser-Engine.
	 */
	public static function serverBase(array $config, array $roleIds): string {
		$parts = [];
		foreach (self::allRoles($config) as $r) {
			if (!in_array($r['id'], $roleIds, true)) {
				continue;
			}
			$words = explode('-', $r['short']);
			if ($parts && count($words) > 1 && in_array($words[0], $parts, true)) {
				array_shift($words);
			}
			array_push($parts, ...$words);
		}
		return implode('-', $parts);
	}

	/**
	 * The roles a host holds, from its host groups, in role order. A role whose group is its
	 * family's (Forwarder in Forwarders) counts only when the host is not there on behalf of
	 * another role that stands for that family (Single node joins Forwarders too).
	 */
	public static function rolesOfGroups(array $config, array $groups): array {
		$out = [];
		$covered = [];
		foreach ($config['families'] as $f) {
			foreach ($f['roles'] as $r) {
				if (!in_array($r['group'], $groups, true)) {
					continue;
				}
				if ($r['group'] === $f['group'] && count($f['roles']) > 1) {
					continue;
				}
				$out[] = $r + ['family' => $f['id'], 'familyGroup' => $f['group']];
				if ($r['group'] !== $f['group'] || count($f['roles']) === 1) {
					foreach ((array) ($r['alsoIn'] ?? []) as $fid) {
						$covered[$fid] = true;
					}
				}
			}
		}
		// Drop a role seen only through the group of a family another role stands for.
		$fam = array_column($config['families'], null, 'id');
		return array_values(array_filter($out, function ($r) use ($covered, $fam) {
			return !(isset($covered[$r['family']]) && $r['group'] === $fam[$r['family']]['group'] && empty($r['alsoIn']));
		}));
	}

	/**
	 * The template names this Zabbix uses, from templates.json in the data folder:
	 *   { "agent": "Linux by Zabbix agent -X", "cluster": "Elasticsearch Cluster by HTTP X" }
	 * A Zabbix whose templates are called something else — a site's own names, or the names an
	 * earlier release shipped — is pointed at them here rather than by editing PHP. A name left
	 * out or left empty means the default above.
	 */
	public static function templateNames(): array {
		$saved = Store::read(self::TEMPLATES_FILE, []);
		$name = function (string $key, string $fallback) use ($saved): string {
			$v = trim((string) ($saved[$key] ?? ''));
			return $v !== '' && strlen($v) <= 128 ? $v : $fallback;
		};
		return ['agent' => $name('agent', self::DEFAULT_TEMPLATE), 'cluster' => $name('cluster', self::DEFAULT_CLUSTER_TEMPLATE)];
	}

	/** The template a server gets when its roles name none. */
	public static function defaultTemplate(): string {
		return self::templateNames()['agent'];
	}

	/** The Elasticsearch template the cluster host is linked to. */
	public static function clusterTemplate(): string {
		return self::templateNames()['cluster'];
	}

	/** Template names as typed; a blank one is removed, so the default applies again. */
	public static function saveTemplateNames(array $in): array {
		$clean = [];
		foreach (['agent', 'cluster'] as $k) {
			$v = trim((string) ($in[$k] ?? ''));
			if ($v !== '') {
				if (strlen($v) > 128) {
					throw new \InvalidArgumentException(sprintf('The %s template name is too long.', $k));
				}
				$clean[$k] = $v;
			}
		}
		Store::write(self::TEMPLATES_FILE, $clean);
		return self::templateNames();
	}

	/** A role's templates: those it names, or the default. */
	public static function roleTemplates(array $role): array {
		$t = array_values(array_filter(array_map('trim', (array) ($role['templates'] ?? [])), fn($x) => $x !== ''));
		return $t ?: [self::defaultTemplate()];
	}

	/** The templates a server with these roles is linked to: every role's, once. */
	public static function templatesOf(array $config, array $roleIds): array {
		$byId = self::byId($config);
		$out = [];
		foreach ($roleIds as $rid) {
			foreach (isset($byId[$rid]) ? self::roleTemplates($byId[$rid]) : [] as $t) {
				$out[$t] = true;
			}
		}
		return array_keys($out);
	}

	/** Every family group a server with these roles joins. */
	public static function familyGroupsOf(array $config, array $roleIds): array {
		$byId = self::byId($config);
		$fam = array_column($config['families'], 'group', 'id');
		$out = [];
		foreach ($roleIds as $rid) {
			if (isset($byId[$rid])) {
				foreach (self::familiesOf($byId[$rid]) as $fid) {
					$out[$fam[$fid]] = true;
				}
			}
		}
		return array_keys($out);
	}

	public static function family(array $config, string $id): ?array {
		foreach ($config['families'] as $f) {
			if ($f['id'] === $id) {
				return $f;
			}
		}
		return null;
	}

	/** The master host macro a role's figure lives in: {$EP.ES_DATA_HOT.CPU.REQUESTED}. */
	public static function macro(string $roleId, string $what): string {
		return '{$EP.'.strtoupper($roleId).'.'.$what.'}';
	}

	/**
	 * The mounts a role's disk is measured on, from the master host's macros: / first, then
	 * each extra disk that has a mount, in slot order.
	 */
	public static function diskMounts(array $macros, string $roleId): array {
		$out = ['/'];
		for ($n = 2; $n <= self::DISK_SLOTS; $n++) {
			$m = trim((string) ($macros[self::macro($roleId, 'DISK'.$n.'.FS')] ?? ''));
			if ($m !== '' && !in_array($m, $out, true)) {
				$out[] = $m;
			}
		}
		return $out;
	}

	/** Every host group the configuration names — the ones reconciling may add a host to or take it out of. */
	public static function groups(array $config): array {
		$out = [];
		foreach ($config['families'] ?? [] as $f) {
			$out[$f['group']] = true;
			foreach ($f['roles'] as $r) {
				$out[$r['group']] = true;
			}
		}
		return array_keys($out);
	}

	/** A short fingerprint, so the Clients page can tell when the master template is behind. */
	public static function hash(array $config): string {
		return substr(sha1(json_encode($config['families'])), 0, 12);
	}
}
