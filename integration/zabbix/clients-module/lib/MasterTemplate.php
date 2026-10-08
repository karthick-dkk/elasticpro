<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

/**
 * The "ElasticPro client master" template, written from the roles.
 *
 * One master host per client carries it. Per role — ES Data Hot, S3 Parser, UEBA … — it works
 * out servers, CPU, memory and disk, each requested (the Clients page's figures, macros on the
 * master host), allocated and used (across that role's machines in the client's host group).
 * Per family — ES, Parser, Forwarder, Engine — the same figures, summed over its roles: a role
 * added later counts at once, because a family's figure adds up every role item tagged with
 * the family rather than a list of them. Plus ES storage and ElasticPro's log delay, a
 * shortfall alert per role, graphs and a three-page dashboard.
 *
 * Built as the array Zabbix exports, and imported as JSON. Family item keys are the ones the
 * Client capacity report reads (ep.es.cpu.requested …); role items are ep.role.<what>[<role>].
 */
class MasterTemplate {

	public const NAME = Roles::TEMPLATE_SLOTS['master'][0];

	/**
	 * The name this template is installed and linked under: the mapping on the Roles page, or
	 * NAME when that slot is unmapped. uuid() is seeded from a fixed string and never from this,
	 * so a site that renames the slot keeps the same template object — Zabbix matches ours by
	 * uuid and renames it rather than making a second one.
	 */
	public static function name(): string {
		return Roles::templateName('master');
	}

	/**
	 * The name this template had before the product was renamed. A legacy value, kept only so
	 * that an install written by an earlier release can be recognised — nothing writes it.
	 *
	 * It is here rather than private to TemplateInstaller because more than one place resolves
	 * clients through this template name, and the old name must mean the same thing in all of
	 * them: a production Zabbix still carries it on every client's master host, and there will
	 * be no migration, so this constant is permanent.
	 */
	public const LEGACY_NAME = 'ElasticVue Pro client master';

	private const GB = 1073741824;

	private const RES_LABEL = ['servers' => 'servers', 'cpu' => 'CPU', 'mem' => 'memory', 'disk' => 'disk'];

	/** @var array */
	private $roles;
	/** @var array[] every item, in order */
	private $items = [];

	public function __construct(array $roles) {
		$this->roles = $roles;
	}

	public static function uuid(string $what): string {
		return self::uuidFrom('elasticpro-client-master/'.$what);
	}

	/**
	 * The uuid an earlier release gave the same $what. The product name is hashed into every
	 * uuid, so the rename changed all of them: the templates on a live install carry these,
	 * and Zabbix therefore treats the imported template as a different object entirely.
	 *
	 * 'espro-client-master/' is a legacy value kept for recognition only. Nothing writes a uuid
	 * from it; it is here so that a template merely *named* like ours can be told from one this
	 * module actually wrote, before anyone is advised to take a template off a host.
	 */
	public static function legacyUuid(string $what): string {
		return self::uuidFrom('espro-client-master/'.$what);
	}

	private static function uuidFrom(string $seed): string {
		$h = hash('sha256', $seed);
		return substr($h, 0, 12).'4'.substr($h, 13, 3).'89ab'[hexdec($h[16]) % 4].substr($h, 17, 15);
	}

	/** Role item key: ep.role.cpu.requested[es_data_hot]. */
	public static function roleKey(string $res, string $kind, string $role): string {
		return 'ep.role.'.$res.'.'.$kind.'['.$role.']';
	}

	/** Family item key: ep.es.cpu.requested. */
	public static function familyKey(string $family, string $res, string $kind): string {
		return 'ep.'.$family.'.'.$res.'.'.$kind;
	}

	/** The mounts a family's disk is measured on: {$EP.FAMILY.ES.DISK1.FS} … DISK5. */
	public static function familyMountMacros(string $family): array {
		return array_map(fn($n) => '{$EP.FAMILY.'.strtoupper($family).'.DISK'.$n.'.FS}', range(1, Roles::DISK_SLOTS));
	}

	/** A filter matching any of these mounts; an empty one matches nothing. */
	private static function mountFilter(array $macros): string {
		return '('.implode(' or ', array_map(fn($m) => 'tag="filesystem:'.$m.'"', $macros)).')';
	}

	/** Every master host macro and its default: base settings, then per role. */
	public function macros(): array {
		$m = [
			['{$GRP.CLIENT}', '', 'Client name, and the host group all its hosts are in. Set by the Clients page.'],
			['{$EP.CLIENT.TYPE}', 'On-Prem', 'CI, DI (log archive required) or On-Prem.'],
			['{$ES.URL}', '', 'Elasticsearch URL, shown in the reports.'],
			['{$ES.USERNAME}', 'elastic', 'Elasticsearch user for the cluster and log archive hosts.'],
			['{$EP.ES.PASSWORD.MODE}', 'vault', 'Where the Elasticsearch password is kept: vault (a path:key) or zabbix (a secret macro on the cluster host).'],
			['{$ES.PASSWORD.PATH}', '', 'Vault path:key of the Elasticsearch password.'],
			['{$EP.MONITORED.BY}', '', 'The Zabbix proxy (proxy:<name>) or proxy group (group:<name>) monitoring the client\'s hosts, or jump (Elasticsearch through an SSH jump host). Empty: the Zabbix server.'],
			['{$EP.JUMP.HOST}', '', 'Jump host address, as the Zabbix server reaches it.'],
			['{$EP.JUMP.PORT}', '22', 'Jump host SSH port.'],
			['{$EP.JUMP.USER}', '', 'SSH user on the jump host.'],
			['{$EP.JUMP.KEY}', 'id_ed25519', 'Private key file in the Zabbix server\'s SSH key folder.'],
			['{$EP.ALERT.DL}', '0', 'Email the client\'s problems to its cluster DL: 1 or 0. Set by Cluster Management, which keeps the Zabbix action for it.'],
			['{$EP.REPORT.WEEKLY}', '0', 'Mail the client\'s weekly report (PDF) to its cluster DL: 1 or 0. Set by Cluster Management.'],
			['{$EP.JUMP.TLS}', 'verify', 'The cluster\'s certificate, checked on the jump host: verify (Windows trust store), ca (a CA file there) or none.'],
			['{$EP.JUMP.CA}', '', 'CA file on the jump host, when the certificate check is "ca".'],
			['{$EP.ES.APIKEY.PATH}', '', 'Vault path:key of the read-only Elasticsearch API key used through the jump host.'],
			['{$EP.CLIENT.STATUS}', 'active', 'active, disabled or decommissioned. Set by Cluster Management; maintenance is read from Zabbix.'],
			['{$EP.LEAD}', '', 'SOC / Manager lead of this client.'],
			['{$EP.DL}', '', 'The cluster DL: the mailing list for this client.'],
			['{$EP.CONTRACT.END}', '', 'Contract end date, YYYY-MM-DD.'],
			['{$ULM.S3.BUCKET}', '(not set)', 'This client\'s archive bucket.'],
			['{$ULM.S3.REGION}', 'us-east-1', 'The bucket\'s region.'],
			['{$ULM.AWS.AUTH}', 'role_base', 'role_base or access_key.'],
			['{$ULM.AWS.ROLE.ARN}', '', 'Role to assume for the bucket.'],
			['{$ULM.AWS.EXTERNAL.ID}', '', 'External ID for the role, if any.'],
			['{$ULM.AWS.ACCESS.KEY.ID}', '', 'access_key only.'],
			['{$ULM.AWS.SECRET.PATH}', '', 'access_key only: Vault path:key of the secret.'],
			['{$ULM.S3.RAW.PREFIX}', 'rawlog', 'Folder of the raw copy.'],
			['{$ULM.S3.ENRICHED.PREFIX}', 'enrichedlog', 'Folder of the enriched copy.'],
			['{$ULM.ES.INDEX}', 'logstash-*', 'Indices holding the logs.'],
			['{$ULM.ES.TAG.FIELD}', 'tag1.keyword', 'The field whose value is the tag folder.'],
			['{$ULM.ES.BRANCH.FIELD}', 'branch.keyword', 'The field whose value is the branch folder.'],
			['{$ULM.TIMEZONE}', 'UTC', 'Time zone of the date= folders.'],
			['{$AGENT.PORT}', '10050', 'Agent port of the Linux hosts the Clients page creates.'],
			['{$EP.PURCHASED.BY}', 'storage', 'How the client bought the service: storage (GB) or devices.'],
			['{$ES.VOLUME.CUS.PURCHASED}', '0', 'Storage the customer purchased, GB.'],
			['{$EP.DEVICES.PURCHASED}', '0', 'Devices the customer purchased.'],
			['{$EP.USAGE.WARN}', '80', 'Usage at or above this is yellow.'],
			['{$EP.USAGE.HIGH}', '90', 'Usage at or above this is red.'],
			['{$EP.ROLES.HASH}', Roles::hash($this->roles), 'Which roles this template was written for. Set by the Clients page.']
		];
		foreach ($this->roles['families'] as $f) {
			foreach (self::familyMountMacros($f['id']) as $i => $macro) {
				$m[] = [$macro, $i === 0 ? '/' : '', $f['label'].': a mount measured as the family\'s disk. Set by the Clients page from its roles.'];
			}
		}
		foreach (Roles::allRoles($this->roles) as $r) {
			$m[] = [Roles::macro($r['id'], 'SERVER.COUNT.REQUESTED'), '0', $r['label'].': servers requested.'];
			$m[] = [Roles::macro($r['id'], 'CPU.REQUESTED'), '0', $r['label'].': CPU requested, cores.'];
			$m[] = [Roles::macro($r['id'], 'MEMORY.REQUESTED'), '0', $r['label'].': memory requested, GB.'];
			$m[] = [Roles::macro($r['id'], 'ROOTDISK.REQUESTED'), '0', $r['label'].': disk / requested, GB.'];
			for ($n = 2; $n <= Roles::DISK_SLOTS; $n++) {
				$m[] = [Roles::macro($r['id'], 'DISK'.$n.'.FS'), '', $r['label'].": extra disk $n, its mount (e.g. /data). Empty: none."];
				$m[] = [Roles::macro($r['id'], 'DISK'.$n.'.REQUESTED'), '0', $r['label'].": extra disk $n requested, GB."];
			}
		}
		return $m;
	}

	/** The whole export, ready for configuration.import. */
	public function export(): array {
		$this->items = [];
		$this->baseItems();
		foreach ($this->roles['families'] as $f) {
			foreach ($f['roles'] as $r) {
				$this->roleItems($f, $r);
			}
		}
		foreach ($this->roles['families'] as $f) {
			$this->familyItems($f);
		}

		$template = [
			'uuid' => self::uuid('template'),
			'template' => self::NAME,
			'name' => self::NAME,
			'description' => 'One master host per client, made and kept by the Clients page (ElasticPro menu). Requested, allocated and used per role and per family, ES storage and ElasticPro\'s log delay. Written by the Clients page from its roles — edit roles there, not here.',
			'vendor' => ['name' => 'ElasticPro', 'version' => '7.0-3'],
			'groups' => [['name' => 'Templates/Applications']],
			'items' => array_values(array_map([$this, 'itemExport'], $this->items)),
			'macros' => array_map(fn($m) => ['macro' => $m[0], 'value' => $m[1], 'description' => $m[2]], $this->macros()),
			'dashboards' => [$this->dashboard()],
			'valuemaps' => [[
				'uuid' => self::uuid('valuemap/not-set'),
				'name' => 'ElasticPro not set',
				'mappings' => [['value' => '0', 'newvalue' => 'not set']]
			]]
		];

		return ['zabbix_export' => [
			'version' => '7.0',
			'templates' => [$template],
			'triggers' => $this->triggers(),
			'graphs' => $this->graphs()
		]];
	}

	/* ------------------------------------ items ------------------------------------ */

	/** Share of what was bought that is in use, per purchase basis; over 100 is over what was bought. */
	public const OVER = ['storage' => 'ep.es.storage.purchased.usage', 'devices' => 'ep.devices.usage'];

	private function add(string $key, string $name, string $units, string $params, string $description, string $kind, array $tags = [], string $delay = '1m'): void {
		$this->items[$key] = compact('key', 'name', 'units', 'params', 'description', 'kind', 'tags', 'delay');
	}

	private function itemExport(array $it): array {
		$out = [
			'uuid' => self::uuid('item/'.$it['key']),
			'name' => $it['name'],
			'type' => 'CALCULATED',
			'key' => $it['key'],
			'delay' => $it['delay'],
			'value_type' => 'FLOAT',
			'params' => $it['params'],
			'description' => $it['description'],
			'tags' => array_merge([
				['tag' => 'component', 'value' => $it['kind'] === 'delay' ? 'log-delay' : 'capacity'],
				['tag' => 'kind', 'value' => $it['kind']]
			], $it['tags'])
		];
		if ($it['units'] !== '') {
			$out['units'] = $it['units'];
		}
		if ($it['kind'] === 'requested') {
			$out['valuemap'] = ['name' => 'ElasticPro not set'];
		}
		return $out;
	}

	private function baseItems(): void {
		$client = 'group="{$GRP.CLIENT}"';
		$this->add('ep.es.storage.purchased', 'ES storage purchased by the customer', 'B', '{$ES.VOLUME.CUS.PURCHASED}*'.self::GB,
			'Static: {$ES.VOLUME.CUS.PURCHASED} GB.', 'requested');
		$this->add('ep.es.storage.allocated', 'ES storage allocated', 'B', 'max(last_foreach(/*/es.nodes.fs.total_in_bytes?['.$client.']))',
			'All file stores of the cluster, from its cluster host.', 'allocated');
		$this->add('ep.es.storage.used', 'ES storage used', 'B', 'max(last_foreach(/*/es.nodes.fs.used_in_bytes?['.$client.']))',
			'From the cluster host.', 'used');
		$this->add('ep.es.storage.usage', 'ES storage usage', '%', '100*last(//ep.es.storage.used)/last(//ep.es.storage.allocated)',
			'Used as a share of allocated.', 'usage');

		$this->add(self::OVER['storage'], 'ES storage used as a share of purchased', '%', '100*last(//ep.es.storage.used)/last(//ep.es.storage.purchased)',
			'Over 100 % when the client uses more storage than it bought. Empty while no purchased storage is set.', 'usage', [], '10m');

		// Seconds until ES storage is full at the last week's growth; -1 when it does not grow.
		$this->add('ep.es.storage.full_in', 'ES storage full in', 's', 'timeleft(//ep.es.storage.usage,7d,100)',
			'At the growth of the last 7 days. Very large when storage is not growing.', 'usage', [], '1h');
		$this->add('ep.devices.purchased', 'Devices purchased by the customer', '', '{$EP.DEVICES.PURCHASED}',
			'Static: {$EP.DEVICES.PURCHASED}. 0 = not set.', 'requested');
		$this->add('ep.devices.seen', 'Devices seen', '', 'sum(last_foreach(/*/'.DevicesTemplate::KEY.'?['.$client.']))',
			'Distinct devices with logs in the cluster, from its cluster host (every 6 hours).', 'used', [], '10m');
		$this->add('ep.devices.usage', 'Devices seen as a share of purchased', '%', '100*last(//ep.devices.seen)/last(//ep.devices.purchased)',
			'Empty while no purchased count is set.', 'usage', [], '10m');

		foreach ([['late', 'devices late', ''], ['devices', 'devices measured', ''], ['critical', 'devices critical', ''],
				['median', 'median delay', 's'], ['worst', 'worst delay', 's']] as [$k, $n, $u]) {
			$this->add('ep.delay.'.$k, 'Log delay: '.$n, $u, 'max(last_foreach(/*/elasticpro.delay['.$k.']?['.$client.'],1h))',
				'From ElasticPro, measured every 15 minutes. Empty without a measurement from the last hour.', 'delay');
		}
		foreach ([['avg', 'late', '1h', 'devices late, hourly average'], ['max', 'late', '1h', 'devices late, hourly peak'],
				['avg', 'late', '1d', 'devices late, daily average'], ['max', 'late', '1d', 'devices late, daily peak'],
				['avg', 'median', '1h', 'median delay, hourly average'], ['avg', 'median', '1d', 'median delay, daily average']] as [$fn, $k, $span, $label]) {
			$this->add('ep.delay.'.$k.'.'.$fn.'['.$span.']', 'Log delay: '.$label, $k === 'median' ? 's' : '', $fn.'(//ep.delay.'.$k.','.$span.')',
				($fn === 'avg' ? 'Average' : 'Highest').' over the last '.$span.'.', 'delay', [], '5m');
		}
		foreach ([['late', '1h', 'devices late, change on the previous hour'], ['late', '1d', 'devices late, change on the previous day'],
				['median', '1d', 'median delay, change on the previous day']] as [$k, $span, $label]) {
			$this->add('ep.delay.'.$k.'.change['.$span.']', 'Log delay: '.$label, $k === 'median' ? 's' : '',
				'avg(//ep.delay.'.$k.','.$span.')-avg(//ep.delay.'.$k.','.$span.':now-'.$span.')', 'This '.$span.' against the '.$span.' before it.', 'delay', [], '5m');
		}
	}

	private function roleItems(array $f, array $r): void {
		$in = 'group="{$GRP.CLIENT}" and group="'.$r['group'].'"';
		// / and the role's extra disks. The mounts are macros; Zabbix substitutes none inside an
		// aggregate's key, so the key is a wildcard and the Linux template's `filesystem` tag picks
		// the mounts. An extra disk with no mount matches nothing, so it never makes this unknown.
		$mounts = self::mountFilter(array_merge(['/'], array_map(fn($n) => Roles::macro($r['id'], 'DISK'.$n.'.FS'), range(2, Roles::DISK_SLOTS))));
		$requested = '('.implode('+', array_map(fn($n) => Roles::macro($r['id'], $n === 1 ? 'ROOTDISK.REQUESTED' : 'DISK'.$n.'.REQUESTED'), range(1, Roles::DISK_SLOTS))).')*'.self::GB;
		// Tagged with every family the role counts in, so each family's sums pick it up.
		$tags = array_merge(array_map(fn($fid) => ['tag' => 'family', 'value' => $fid], Roles::familiesOf($r + ['family' => $f['id']])),
			[['tag' => 'role', 'value' => $r['id']]]);
		$k = fn($res, $kind) => self::roleKey($res, $kind, $r['id']);
		$L = $r['label'];

		$this->add($k('servers', 'requested'), "$L servers requested", '', Roles::macro($r['id'], 'SERVER.COUNT.REQUESTED'), 'Static, from the Clients page. 0 = not set.', 'requested', $tags);
		$this->add($k('servers', 'allocated'), "$L servers allocated", '', 'count(last_foreach(/*/system.cpu.num?['.$in.']))', "Machines in the $L group of this client.", 'allocated', $tags);
		$this->add($k('cpu', 'requested'), "$L CPU requested", '', Roles::macro($r['id'], 'CPU.REQUESTED'), 'Static, cores. 0 = not set.', 'requested', $tags);
		$this->add($k('cpu', 'allocated'), "$L CPU allocated", '', 'sum(last_foreach(/*/system.cpu.num?['.$in.']))', 'Cores across its machines.', 'allocated', $tags);
		$this->add($k('cpu', 'usage'), "$L CPU usage", '%', 'avg(last_foreach(/*/system.cpu.util?['.$in.']))', 'Average across its machines.', 'usage', $tags);
		$this->add($k('mem', 'requested'), "$L memory requested", 'B', Roles::macro($r['id'], 'MEMORY.REQUESTED').'*'.self::GB, 'Static, GB. 0 = not set.', 'requested', $tags);
		$this->add($k('mem', 'allocated'), "$L memory allocated", 'B', 'sum(last_foreach(/*/vm.memory.size[total]?['.$in.']))', 'Across its machines.', 'allocated', $tags);
		$this->add($k('mem', 'usage'), "$L memory usage", '%', 'avg(last_foreach(/*/vm.memory.utilization?['.$in.']))', 'Average across its machines.', 'usage', $tags);
		$this->add($k('disk', 'requested'), "$L disk requested", 'B', $requested, 'Static: / and every extra disk, GB. 0 = not set.', 'requested', $tags);
		$this->add($k('disk', 'allocated'), "$L disk allocated", 'B', 'sum(last_foreach(/*/vfs.fs.dependent.size[*,total]?['.$in.' and '.$mounts.']))', 'The role\'s mounts (/ and its extra disks), across its machines.', 'allocated', $tags);
		$this->add($k('disk', 'used'), "$L disk used", 'B', 'sum(last_foreach(/*/vfs.fs.dependent.size[*,used]?['.$in.' and '.$mounts.']))', 'The role\'s mounts (/ and its extra disks), across its machines.', 'used', $tags);
		$this->add($k('disk', 'usage'), "$L disk usage", '%', '100*last(//'.$k('disk', 'used').')/last(//'.$k('disk', 'allocated').')', 'Used as a share of allocated.', 'usage', $tags);
	}

	private function familyItems(array $f): void {
		$client = 'group="{$GRP.CLIENT}"';
		$in = $client.' and group="'.$f['group'].'"';
		$sum = fn($res, $kind) => 'sum(last_foreach(/*/ep.role.'.$res.'.'.$kind.'[*]?['.$client.' and tag="family:'.$f['id'].'"]))';
		$k = fn($res, $kind) => self::familyKey($f['id'], $res, $kind);
		$L = $f['label'];
		$by = 'Summed over its roles.';

		$this->add($k('servers', 'requested'), "$L servers requested", '', $sum('servers', 'requested'), $by, 'requested');
		$this->add($k('servers', 'allocated'), "$L servers allocated", '', 'count(last_foreach(/*/system.cpu.num?['.$in.']))', "Machines in the {$f['group']} group of this client.", 'allocated');
		$this->add($k('cpu', 'requested'), "$L CPU requested", '', $sum('cpu', 'requested'), $by, 'requested');
		$this->add($k('cpu', 'allocated'), "$L CPU allocated", '', 'sum(last_foreach(/*/system.cpu.num?['.$in.']))', 'Cores across its machines.', 'allocated');
		$this->add($k('cpu', 'usage'), "$L CPU usage", '%', 'avg(last_foreach(/*/system.cpu.util?['.$in.']))', 'Average across its machines.', 'usage');
		$this->add($k('mem', 'requested'), "$L memory requested", 'B', $sum('mem', 'requested'), $by, 'requested');
		$this->add($k('mem', 'allocated'), "$L memory allocated", 'B', 'sum(last_foreach(/*/vm.memory.size[total]?['.$in.']))', 'Across its machines.', 'allocated');
		$this->add($k('mem', 'usage'), "$L memory usage", '%', 'avg(last_foreach(/*/vm.memory.utilization?['.$in.']))', 'Average across its machines.', 'usage');
		// Across the family's machines on the family's mounts (the Clients page sets them from the
		// roles in use), so a server holding two of the family's roles counts once, like its CPU.
		$fs = self::mountFilter(self::familyMountMacros($f['id']));
		$this->add($k('disk', 'requested'), "$L disk requested", 'B', $sum('disk', 'requested'), $by, 'requested');
		$this->add($k('disk', 'allocated'), "$L disk allocated", 'B', 'sum(last_foreach(/*/vfs.fs.dependent.size[*,total]?['.$in.' and '.$fs.']))',
			'The family\'s mounts, across its machines.', 'allocated');
		$this->add($k('disk', 'used'), "$L disk used", 'B', 'sum(last_foreach(/*/vfs.fs.dependent.size[*,used]?['.$in.' and '.$fs.']))',
			'The family\'s mounts, across its machines.', 'used');
		$this->add($k('disk', 'usage'), "$L disk usage", '%', '100*last(//'.$k('disk', 'used').')/last(//'.$k('disk', 'allocated').')', 'Used as a share of allocated.', 'usage');
	}

	/* ------------------------------------ alerts ------------------------------------ */

	private function triggers(): array {
		$T = self::NAME;
		$out = [];
		$short = function(string $id, string $what, string $req, string $alloc, string $word = 'requested') use ($T): array {
			return [
				'uuid' => self::uuid('trigger/shortfall/'.$id),
				'expression' => "last(/$T/$req)>0 and last(/$T/$alloc)<last(/$T/$req)",
				'name' => '{$GRP.CLIENT}: '.$what.' allocated below '.$word,
				'event_name' => '{$GRP.CLIENT}: '.$what.' allocated {ITEM.LASTVALUE2} is below '.$word.' {ITEM.LASTVALUE1}',
				'priority' => 'AVERAGE',
				'description' => 'What the client was given is less than what was '.$word.'. Raised only when a '.$word.' figure is set.',
				'tags' => [['tag' => 'scope', 'value' => 'capacity']]
			];
		};
		$out[] = [
			'uuid' => self::uuid('trigger/over/storage'),
			'expression' => 'last(/'.$T.'/ep.es.storage.purchased)>0 and last(/'.$T.'/'.self::OVER['storage'].')>100',
			'name' => '{$GRP.CLIENT}: ES storage used is over what was purchased',
			'event_name' => '{$GRP.CLIENT}: ES storage used is {ITEM.LASTVALUE2} of what was purchased',
			'priority' => 'WARNING',
			'description' => 'The client stores more than it bought. Raised only when purchased storage is set.',
			'tags' => [['tag' => 'scope', 'value' => 'capacity']]
		];
		foreach (Roles::allRoles($this->roles) as $r) {
			foreach (Roles::RESOURCES as $res) {
				$out[] = $short($r['id'].'.'.$res, $r['label'].' '.self::RES_LABEL[$res],
					self::roleKey($res, 'requested', $r['id']), self::roleKey($res, 'allocated', $r['id']));
			}
		}
		$out[] = $short('es.storage', 'ES storage', 'ep.es.storage.purchased', 'ep.es.storage.allocated', 'purchased');
		return $out;
	}

	private function graphs(): array {
		$colors = ['F63100', '2774A4', '1A7C11', 'A54F10', '7E57C2', '00897B', 'C2185B', '5D4037'];
		$fam = $this->roles['families'];
		$defs = [
			['Log delay: devices late', ['ep.delay.late', 'ep.delay.late.avg[1h]', 'ep.delay.late.avg[1d]']],
			['Log delay: median delay', ['ep.delay.median', 'ep.delay.median.avg[1h]', 'ep.delay.median.avg[1d]']],
			['CPU usage by family', array_map(fn($f) => self::familyKey($f['id'], 'cpu', 'usage'), $fam)],
			['Memory usage by family', array_map(fn($f) => self::familyKey($f['id'], 'mem', 'usage'), $fam)],
			['Storage usage', array_merge(['ep.es.storage.usage'], array_map(fn($f) => self::familyKey($f['id'], 'disk', 'usage'), $fam))]
		];
		$out = [];
		foreach ($defs as [$name, $keys]) {
			$items = [];
			foreach ($keys as $i => $key) {
				$items[] = ['sortorder' => (string) $i, 'color' => $colors[$i % count($colors)], 'item' => ['host' => self::NAME, 'key' => $key]];
			}
			$out[] = ['uuid' => self::uuid('graph/'.$name), 'name' => $name, 'graph_items' => $items];
		}
		return $out;
	}

	/* ------------------------------------ dashboard ------------------------------------ */

	private function tile(string $key, int $x, int $y, int $w, string $label, bool $usage = false, int $decimals = 0): array {
		$fields = [
			['type' => 'ITEM', 'name' => 'itemid.0', 'value' => ['host' => self::NAME, 'key' => $key]],
			['type' => 'INTEGER', 'name' => 'decimal_places', 'value' => (string) $decimals],
			['type' => 'INTEGER', 'name' => 'show.0', 'value' => '1'],
			['type' => 'INTEGER', 'name' => 'show.1', 'value' => '2'],
			['type' => 'STRING', 'name' => 'description', 'value' => $label],
			['type' => 'INTEGER', 'name' => 'desc_v_pos', 'value' => '0'],
			['type' => 'INTEGER', 'name' => 'desc_size', 'value' => '9'],
			['type' => 'INTEGER', 'name' => 'value_size', 'value' => '24']
		];
		if ($usage) {
			// Yellow at 80 %, red at 90 % — the reports' {$EP.USAGE.*} defaults.
			foreach ([['FFD54F', '80'], ['E53935', '90']] as $i => [$color, $at]) {
				$fields[] = ['type' => 'STRING', 'name' => "thresholds.$i.color", 'value' => $color];
				$fields[] = ['type' => 'STRING', 'name' => "thresholds.$i.threshold", 'value' => $at];
			}
		}
		return ['type' => 'item', 'name' => $label, 'x' => (string) $x, 'y' => (string) $y, 'width' => (string) $w, 'height' => '3',
			'hide_header' => 'YES', 'fields' => $fields];
	}

	private function graphWidget(string $graph, int $x, int $y, int $w): array {
		return ['type' => 'graph', 'name' => $graph, 'x' => (string) $x, 'y' => (string) $y, 'width' => (string) $w, 'height' => '5',
			'fields' => [['type' => 'GRAPH', 'name' => 'graphid.0', 'value' => ['host' => self::NAME, 'name' => $graph]]]];
	}

	private function dashboard(): array {
		$cap = [];
		$cells = [['servers', 'allocated', 'servers'], ['cpu', 'requested', 'CPU req.'], ['cpu', 'allocated', 'CPU alloc.'], ['cpu', 'usage', 'CPU usage'],
			['mem', 'requested', 'mem req.'], ['mem', 'allocated', 'mem alloc.'], ['mem', 'usage', 'mem usage'], ['disk', 'usage', 'disk usage']];
		$y = 0;
		foreach ($this->roles['families'] as $f) {
			foreach ($cells as $i => [$res, $kind, $label]) {
				$cap[] = $this->tile(self::familyKey($f['id'], $res, $kind), $i * 9, $y, 9, $f['label'].' '.$label, $kind === 'usage', $kind === 'usage' ? 1 : 0);
			}
			$y += 3;
		}
		$cap[] = $this->graphWidget('CPU usage by family', 0, $y, 36);
		$cap[] = $this->graphWidget('Memory usage by family', 36, $y, 36);

		$storage = [];
		foreach ([['ep.es.storage.purchased', 'ES purchased'], ['ep.es.storage.allocated', 'ES alloc.'], ['ep.es.storage.used', 'ES used'],
				['ep.es.storage.usage', 'ES usage']] as $i => [$key, $label]) {
			$storage[] = $this->tile($key, $i * 9, 0, 9, $label, $key === 'ep.es.storage.usage', $key === 'ep.es.storage.usage' ? 1 : 0);
		}
		foreach (array_values($this->roles['families']) as $i => $f) {
			if ($i < 4) {
				$storage[] = $this->tile(self::familyKey($f['id'], 'disk', 'usage'), (4 + $i) * 9, 0, 9, $f['label'].' disk usage', true, 1);
			}
		}
		$storage[] = $this->graphWidget('Storage usage', 0, 3, 72);

		$delay = [];
		foreach ([['ep.delay.late', 'Late devices'], ['ep.delay.late.avg[1h]', 'Late, 1h avg'], ['ep.delay.late.avg[1d]', 'Late, 1d avg'],
				['ep.delay.late.change[1h]', 'Late vs prev. hour'], ['ep.delay.late.change[1d]', 'Late vs prev. day'], ['ep.delay.median', 'Median delay'],
				['ep.delay.median.change[1d]', 'Median vs prev. day'], ['ep.delay.worst', 'Worst delay']] as $i => [$key, $label]) {
			$delay[] = $this->tile($key, $i * 9, 0, 9, $label);
		}
		$delay[] = $this->graphWidget('Log delay: devices late', 0, 3, 36);
		$delay[] = $this->graphWidget('Log delay: median delay', 36, 3, 36);

		return ['uuid' => self::uuid('dashboard'), 'name' => 'Client capacity and log delay', 'pages' => [
			['name' => 'Capacity', 'widgets' => $cap],
			['name' => 'Storage', 'widgets' => $storage],
			['name' => 'Log delay', 'widgets' => $delay]
		]];
	}
}
