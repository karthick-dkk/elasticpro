<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

/**
 * A client, as the form or a CSV row describes it: checked, and turned into the macros each of
 * its hosts carries. Pure — no Zabbix API — so it is tested on its own (test/spec.test.php).
 *
 * Nothing is guessed. A server that is not an IPv4 address, a URL that is not
 * scheme://host[:port], a Vault reference that is not path:key: each is named in the errors,
 * and nothing is saved until the form is right.
 *
 * Servers are one list — each an IP with one or more roles, extra services, notes and
 * attributes — kept in the form as canonical JSON in the `servers` field, so a backup, a CSV
 * import and the form compare the same way.
 */
class ClientSpec {

	public const UNSET_BUCKET = '(not set)';
	public const TYPES = ClientTypes::ALL;
	public const PASSWORD_MODES = ['vault', 'zabbix'];
	public const PURCHASED_BY = ['storage', 'devices'];
	public const JUMP_TLS = ['verify', 'ca', 'none'];

	/** curl.exe's certificate options for a jump host client: none (check with the trust store), --cacert, or -k. */
	public static function curlTls(string $mode, string $ca): string {
		return $mode === 'none' ? '-k' : ($mode === 'ca' && $ca !== '' ? '--cacert "'.$ca.'"' : '');
	}

	/** Form field => master host macro, for the settings every client has. */
	public const FIELDS = [
		'es_url' => '{$ES.URL}',
		'es_user' => '{$ES.USERNAME}',
		'es_password_mode' => '{$EP.ES.PASSWORD.MODE}',
		'es_password_path' => '{$ES.PASSWORD.PATH}',
		'monitored_by' => '{$EP.MONITORED.BY}',
		'jump_host' => '{$EP.JUMP.HOST}',
		'jump_port' => '{$EP.JUMP.PORT}',
		'jump_user' => '{$EP.JUMP.USER}',
		'jump_key' => '{$EP.JUMP.KEY}',
		'jump_tls' => '{$EP.JUMP.TLS}',
		'jump_ca' => '{$EP.JUMP.CA}',
		'es_apikey_path' => '{$EP.ES.APIKEY.PATH}',
		'lead_name' => '{$EP.LEAD}',
		'cluster_dl' => '{$EP.DL}',
		'alert_dl' => '{$EP.ALERT.DL}',
		'weekly_report' => '{$EP.REPORT.WEEKLY}',
		'contract_end' => '{$EP.CONTRACT.END}',
		'ulm_bucket' => '{$ULM.S3.BUCKET}',
		'ulm_region' => '{$ULM.S3.REGION}',
		'ulm_auth' => '{$ULM.AWS.AUTH}',
		'ulm_role_arn' => '{$ULM.AWS.ROLE.ARN}',
		'ulm_external_id' => '{$ULM.AWS.EXTERNAL.ID}',
		'ulm_access_key_id' => '{$ULM.AWS.ACCESS.KEY.ID}',
		'ulm_secret_path' => '{$ULM.AWS.SECRET.PATH}',
		'ulm_raw_prefix' => '{$ULM.S3.RAW.PREFIX}',
		'ulm_enriched_prefix' => '{$ULM.S3.ENRICHED.PREFIX}',
		'agent_port' => '{$AGENT.PORT}',
		'purchased_by' => '{$EP.PURCHASED.BY}',
		'purchased' => '{$ES.VOLUME.CUS.PURCHASED}',
		'purchased_devices' => '{$EP.DEVICES.PURCHASED}'
	];

	/**
	 * Per role: form field suffix => macro suffix. `disk` is / (always measured); disk2 … disk5
	 * are optional extra disks, each a mount and a size.
	 */
	public const ROLE_FIELDS = [
		'servers' => 'SERVER.COUNT.REQUESTED',
		'cpu' => 'CPU.REQUESTED',
		'mem' => 'MEMORY.REQUESTED',
		'disk' => 'ROOTDISK.REQUESTED',
		'disk2_fs' => 'DISK2.FS', 'disk2' => 'DISK2.REQUESTED',
		'disk3_fs' => 'DISK3.FS', 'disk3' => 'DISK3.REQUESTED',
		'disk4_fs' => 'DISK4.FS', 'disk4' => 'DISK4.REQUESTED',
		'disk5_fs' => 'DISK5.FS', 'disk5' => 'DISK5.REQUESTED'
	];

	/** The requested-disk fields of a role, / first. */
	public static function diskFields(string $roleId): array {
		$out = [$roleId.'_disk'];
		for ($n = 2; $n <= Roles::DISK_SLOTS; $n++) {
			$out[] = $roleId.'_disk'.$n;
		}
		return $out;
	}

	/** What the archive host receives from the master host's settings. */
	public const TO_ULM = ['{$ULM.S3.BUCKET}', '{$ULM.S3.REGION}', '{$ULM.AWS.AUTH}', '{$ULM.AWS.ROLE.ARN}', '{$ULM.AWS.EXTERNAL.ID}',
		'{$ULM.AWS.ACCESS.KEY.ID}', '{$ULM.S3.RAW.PREFIX}', '{$ULM.S3.ENRICHED.PREFIX}', '{$ULM.ES.INDEX}',
		'{$ULM.ES.TAG.FIELD}', '{$ULM.ES.BRANCH.FIELD}', '{$ULM.TIMEZONE}'];

	/** @var array roles configuration */
	private $roles;
	/** @var array macro => default */
	private $defaults;

	public function __construct(array $roles) {
		$this->roles = $roles;
		$this->defaults = [];
		foreach ((new MasterTemplate($roles))->macros() as [$macro, $value]) {
			$this->defaults[$macro] = $value;
		}
	}

	public function roles(): array {
		return $this->roles;
	}

	/** Field name => master macro, for every field the master host keeps. */
	public function macroFields(): array {
		$out = ['type' => '{$EP.CLIENT.TYPE}'] + self::FIELDS;
		foreach (Roles::allRoles($this->roles) as $r) {
			foreach (self::ROLE_FIELDS as $suffix => $what) {
				$out[$r['id'].'_'.$suffix] = Roles::macro($r['id'], $what);
			}
		}
		return $out;
	}

	/** An empty form: the master template's own defaults, and no servers. */
	public function defaults(): array {
		$out = ['name' => ''];
		foreach ($this->macroFields() as $field => $macro) {
			$out[$field] = $this->defaults[$macro] ?? '';
		}
		if ($out['ulm_bucket'] === self::UNSET_BUCKET) {
			$out['ulm_bucket'] = '';
		}
		$out['servers'] = '[]';
		return $out;
	}

	/** What a clone starts without: everything that names or reaches the source client. */
	public const CLONE_CLEARS = ['name', 'es_url', 'es_password_path', 'es_password', 'es_apikey_path', 'lead_name', 'cluster_dl',
		'contract_end', 'ulm_bucket', 'ulm_role_arn', 'ulm_external_id', 'ulm_access_key_id', 'ulm_secret_path'];

	/**
	 * A new client's form started from an existing one: roles, requested capacity, purchase and
	 * settings (monitored by, jump host, region …) copied; no servers, and nothing in CLONE_CLEARS.
	 */
	public function cloneOf(array $form): array {
		$out = array_merge($this->defaults(), array_filter($form, fn($k) => $k[0] !== '_' && $k !== 'merge', ARRAY_FILTER_USE_KEY));
		foreach (self::CLONE_CLEARS as $k) {
			$out[$k] = $this->defaults()[$k] ?? '';
		}
		$out['servers'] = '[]';
		return $out;
	}

	/**
	 * A form saved by an older version (a backup, an old export) in today's terms: machines per
	 * role (ips_<role>) become servers — an IP under several roles one server with all of them —
	 * and fields that are gone (tag1 values, jump host) are dropped.
	 */
	public function upgradeForm(array $form): array {
		if (!array_key_exists('servers', $form)) {
			$servers = [];
			foreach (Roles::allRoles($this->roles) as $r) {
				foreach (self::splitIps((string) ($form['ips_'.$r['id']] ?? '')) as $ip) {
					$servers[$ip] = $servers[$ip] ?? ['ip' => $ip, 'roles' => []];
					$servers[$ip]['roles'][] = $r['id'];
				}
			}
			$form['servers'] = $this->canonServers(array_values($servers));
		}
		foreach (Roles::allRoles($this->roles) as $r) {
			$form = self::legacyDisk($form, $r['id'], (string) ($form[$r['id'].'_disk_fs'] ?? ''));
			unset($form[$r['id'].'_disk_fs']);
		}
		foreach (array_keys($form) as $k) {
			if (strpos((string) $k, 'ips_') === 0 || in_array($k, ['ulm_tags', 'es_jumphost'], true)) {
				unset($form[$k]);
			}
		}
		return $form + $this->defaults();
	}

	/**
	 * A role's disk as it was before extra disks: one size on one mount. On / it stays the /
	 * disk; on any other mount (an ES node's /data) it becomes disk 2, and / is not set.
	 */
	public static function legacyDisk(array $form, string $roleId, string $mount): array {
		$mount = trim($mount);
		if ($mount === '' || $mount === '/' || trim((string) ($form[$roleId.'_disk2_fs'] ?? '')) !== '') {
			return $form;
		}
		$form[$roleId.'_disk2_fs'] = $mount;
		$form[$roleId.'_disk2'] = (string) ($form[$roleId.'_disk'] ?? '0');
		$form[$roleId.'_disk'] = '0';
		return $form;
	}

	/**
	 * The form, checked. Returns ['client' => [...], 'errors' => [...]]; `client` is usable only
	 * when `errors` is empty. `es_password` (a password to keep as a Zabbix secret) and `merge`
	 * (IPs whose duplicate hosts may be merged) are taken from the input but never kept in the form.
	 */
	public function fromForm(array $in): array {
		$errors = [];
		$v = fn(string $k): string => trim((string) ($in[$k] ?? ''));

		$name = $v('name');
		if ($name === '') {
			$errors[] = _('Client name is required: its host group and every host are named after it.');
		}
		elseif (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_\-]{0,47}$/', $name)) {
			$errors[] = _s('Client name "%1$s" may hold only letters, digits, - and _, starting with a letter or digit.', $name);
		}

		$client = ['name' => $name, 'fields' => [], 'servers' => [], 'es' => null,
			'es_password' => (string) ($in['es_password'] ?? ''), 'merge' => self::splitIps((string) ($in['merge'] ?? ''))];
		foreach ($this->macroFields() as $field => $macro) {
			$client['fields'][$field] = $v($field);
		}
		$f = &$client['fields'];

		if (!in_array($f['type'], self::TYPES, true)) {
			$errors[] = _s('Type must be one of %1$s, not "%2$s".', implode(', ', self::TYPES), $f['type']);
		}
		if ($f['es_url'] !== '') {
			$client['es'] = self::esEndpoint($f['es_url']);
			if ($client['es'] === null) {
				$errors[] = _s('ES URL "%1$s" is not scheme://host[:port], e.g. https://es.acme.local:9200.', $f['es_url']);
			}
		}
		if ($f['es_password_mode'] === '') {
			$f['es_password_mode'] = 'vault';
		}
		if (!in_array($f['es_password_mode'], self::PASSWORD_MODES, true)) {
			$errors[] = _('The ES password is kept in Vault or as a Zabbix secret.');
		}
		if ($f['es_password_mode'] === 'zabbix') {
			$f['es_password_path'] = '';
		}
		foreach (['es_password_path' => _('ES password Vault path'), 'ulm_secret_path' => _('S3 secret Vault path')] as $field => $label) {
			if ($f[$field] !== '' && self::vaultRef($f[$field]) === null) {
				$errors[] = _s('%1$s "%2$s" is not a Vault path:key, e.g. secret/elasticpro/acme:password.', $label, $f[$field]);
			}
		}
		if ($f['monitored_by'] !== '' && self::monitoredBy($f['monitored_by']) === null) {
			$errors[] = _s('Monitored by "%1$s" is not proxy:<name>, group:<name> or jump.', $f['monitored_by']);
		}
		// Through a jump host: the Zabbix server signs in with its key and asks Elasticsearch
		// with a read-only API key; the log archive check cannot follow yet.
		if ($f['monitored_by'] === 'jump') {
			if ($f['jump_host'] === '' || !preg_match('/^[A-Za-z0-9.\-]{1,253}$/', $f['jump_host'])) {
				$errors[] = _('A jump host needs its address (host name or IP, as the Zabbix server reaches it).');
			}
			if ($f['jump_user'] === '' || !preg_match('/^[A-Za-z0-9._\\@\-]{1,64}$/', $f['jump_user'])) {
				$errors[] = _('A jump host needs the SSH user Zabbix signs in as.');
			}
			if ($f['es_url'] === '') {
				$errors[] = _('Through a jump host, the ES URL is still needed: the address as the jump host sees it.');
			}
			if (self::vaultRef($f['es_apikey_path']) === null) {
				$errors[] = _('Through a jump host, Elasticsearch is asked with a read-only API key: give its Vault path:key.');
			}
		}
		if ($f['jump_port'] === '') {
			$f['jump_port'] = '22';
		}
		elseif (!preg_match('/^\d{1,5}$/', $f['jump_port'])) {
			$errors[] = _('Jump host SSH port must be a number.');
		}
		if ($f['jump_key'] === '') {
			$f['jump_key'] = 'id_ed25519';
		}
		elseif (!preg_match('/^[A-Za-z0-9._\-]{1,64}$/', $f['jump_key'])) {
			$errors[] = _('The SSH key is a file name in the Zabbix server\'s key folder, e.g. id_ed25519.');
		}
		// The cluster's certificate is checked on the jump host: by Windows' trust store, or a CA file
		// there. Not checking is a choice made per client, since the API key goes to whoever answers.
		if ($f['jump_tls'] === '') {
			$f['jump_tls'] = 'verify';
		}
		if (!in_array($f['jump_tls'], self::JUMP_TLS, true)) {
			$errors[] = _s('Certificate check "%1$s" is not one of %2$s.', $f['jump_tls'], implode(', ', self::JUMP_TLS));
		}
		elseif ($f['jump_tls'] === 'ca' && !preg_match('#^[A-Za-z0-9:\\\\/._ -]{1,260}$#', $f['jump_ca'])) {
			$errors[] = _('Give the CA file\'s path on the jump host, e.g. C:\\certs\\es-ca.pem.');
		}
		if ($f['jump_tls'] !== 'ca') {
			$f['jump_ca'] = '';
		}
		// Problems by email to the DL: a yes/no, and only with a DL to send to.
		$f['alert_dl'] = in_array($f['alert_dl'], ['1', 'yes', 'on', 'true'], true) ? '1' : '0';
		if ($f['alert_dl'] === '1' && $f['cluster_dl'] === '') {
			$errors[] = _('Emailing problems to the cluster DL needs the DL.');
		}
		$f['weekly_report'] = in_array($f['weekly_report'], ['1', 'yes', 'on', 'true'], true) ? '1' : '0';
		if ($f['weekly_report'] === '1' && $f['cluster_dl'] === '') {
			$errors[] = _('The weekly report goes to the cluster DL: give the DL.');
		}
		if ($f['cluster_dl'] !== '' && !preg_match('/^[^@\s]+@[^@\s]+\.[^@\s]+$/', $f['cluster_dl'])) {
			$errors[] = _s('Cluster DL "%1$s" is not an email address.', $f['cluster_dl']);
		}
		if ($f['contract_end'] !== '' && (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $f['contract_end']) || strtotime($f['contract_end']) === false)) {
			$errors[] = _s('Contract end "%1$s" is not a date like 2026-12-31.', $f['contract_end']);
		}
		if ($f['ulm_auth'] === '') {
			$f['ulm_auth'] = 'role_base';
		}
		if (!in_array($f['ulm_auth'], ['role_base', 'access_key'], true)) {
			$errors[] = _('S3 access must be the instance role or an access key.');
		}
		if ($f['ulm_bucket'] === '') {
			$f['ulm_bucket'] = self::UNSET_BUCKET;
		}
		elseif ($f['ulm_bucket'] !== self::UNSET_BUCKET && !preg_match('/^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/', $f['ulm_bucket'])) {
			$errors[] = _s('S3 bucket "%1$s" is not a valid bucket name.', $f['ulm_bucket']);
		}
		if ($f['type'] === 'DI') {
			// DI clients' logs are archived: the archive check cannot run without these.
			if ($f['ulm_bucket'] === self::UNSET_BUCKET) {
				$errors[] = _('A DI client needs its S3 bucket.');
			}
			if ($f['ulm_region'] === '') {
				$errors[] = _('A DI client needs its S3 region.');
			}
			if ($f['es_url'] === '') {
				$errors[] = _('A DI client needs its ES URL: the archive check reads Elasticsearch.');
			}
		}
		if ($f['ulm_auth'] === 'access_key' && $f['ulm_bucket'] !== self::UNSET_BUCKET && $f['ulm_access_key_id'] === '') {
			$errors[] = _('S3 access by access key needs the access key ID.');
		}
		if ($f['agent_port'] === '') {
			$f['agent_port'] = '10050';
		}
		elseif (!preg_match('/^\d{1,5}$/', $f['agent_port'])) {
			$errors[] = _('Agent port must be a number.');
		}
		if ($f['purchased_by'] === '') {
			$f['purchased_by'] = 'storage';
		}
		if (!in_array($f['purchased_by'], self::PURCHASED_BY, true)) {
			$errors[] = _s('Purchased by must be storage or devices, not "%1$s".', $f['purchased_by']);
		}

		$numbers = ['purchased' => _('Purchased storage'), 'purchased_devices' => _('Purchased devices')];
		foreach (Roles::allRoles($this->roles) as $r) {
			foreach (['servers' => _('servers'), 'cpu' => _('CPU'), 'mem' => _('memory'), 'disk' => _('disk /')] as $suffix => $what) {
				$numbers[$r['id'].'_'.$suffix] = $r['label'].' '.$what.' '._('requested');
			}
			for ($n = 2; $n <= Roles::DISK_SLOTS; $n++) {
				$numbers[$r['id'].'_disk'.$n] = _s('%1$s disk %2$s requested', $r['label'], $n);
			}
		}
		foreach ($numbers as $field => $label) {
			if ($f[$field] === '') {
				$f[$field] = '0';
			}
			elseif (!is_numeric($f[$field]) || (float) $f[$field] < 0) {
				$errors[] = _s('%1$s must be a number of 0 or more (0 means not set), not "%2$s".', $label, $f[$field]);
			}
		}
		// One measure is bought; the other is not set, so its alarm stays quiet.
		$f[$f['purchased_by'] === 'devices' ? 'purchased' : 'purchased_devices'] = '0';
		// Extra disks: a mount of its own (not /, not twice), and a size only with a mount.
		foreach (Roles::allRoles($this->roles) as $r) {
			$seen = ['/'];
			for ($n = 2; $n <= Roles::DISK_SLOTS; $n++) {
				$fs = &$f[$r['id'].'_disk'.$n.'_fs'];
				$gb = $f[$r['id'].'_disk'.$n];
				if ($fs === '') {
					if ((float) $gb > 0) {
						$errors[] = _s('%1$s disk %2$s has a size but no mount.', $r['label'], $n);
					}
					continue;
				}
				if (!preg_match('~^/[A-Za-z0-9._\-/]{1,127}$~', $fs) || $fs === '/') {
					$errors[] = _s('%1$s disk %2$s: "%3$s" is not a mount like /data (/ is always measured).', $r['label'], $n, $fs);
				}
				elseif (in_array($fs, $seen, true)) {
					$errors[] = _s('%1$s lists the mount %2$s twice.', $r['label'], $fs);
				}
				$seen[] = $fs;
			}
			unset($fs);
		}
		unset($f);

		['servers' => $client['servers'], 'errors' => $serverErrors] = $this->parseServers((string) ($in['servers'] ?? '[]'));
		$errors = array_merge($errors, $serverErrors);
		$client['servers_json'] = self::encodeServers($client['servers']);

		return ['client' => $client, 'errors' => $errors];
	}

	/* ------------------------------------ servers ------------------------------------ */

	/**
	 * The servers field, checked: IP => {ip, roles, services, notes, attrs}. Roles come back in
	 * role order, services and attributes sorted, so two forms saying the same thing are equal.
	 */
	public function parseServers(string $json): array {
		$errors = [];
		$list = $json === '' ? [] : json_decode($json, true);
		if (!is_array($list)) {
			return ['servers' => [], 'errors' => [_('The server list could not be read. Reload the page and add the servers again.')]];
		}
		$byId = Roles::byId($this->roles);
		$order = array_keys($byId);
		$out = [];
		foreach ($list as $i => $s) {
			$ip = trim((string) ($s['ip'] ?? ''));
			$label = $ip !== '' ? $ip : _s('Server %1$s', $i + 1);
			if (!self::isIPv4($ip)) {
				$errors[] = _s('"%1$s" is not an IPv4 address.', $ip);
				continue;
			}
			if (isset($out[$ip])) {
				$errors[] = _s('%1$s is listed twice. Give one server all its roles.', $ip);
				continue;
			}
			$roles = array_values(array_unique(array_map('strval', (array) ($s['roles'] ?? []))));
			foreach ($roles as $rid) {
				if (!isset($byId[$rid])) {
					$errors[] = _s('%1$s: there is no role "%2$s". The roles are on the Roles page.', $label, $rid);
				}
			}
			$roles = array_values(array_filter($roles, fn($rid) => isset($byId[$rid])));
			if (!$roles) {
				$errors[] = _s('%1$s has no role. Pick at least one.', $label);
				continue;
			}
			foreach ($roles as $rid) {
				if (!empty($byId[$rid]['exclusive']) && count($roles) > 1) {
					$errors[] = _s('%1$s: %2$s already stands for every role; it cannot be combined with others.', $label, $byId[$rid]['label']);
					continue 2;
				}
			}
			usort($roles, fn($a, $b) => array_search($a, $order, true) <=> array_search($b, $order, true));
			$services = [];
			foreach ((array) ($s['services'] ?? []) as $svc) {
				$svc = trim((string) $svc);
				if ($svc === '') {
					continue;
				}
				if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9._\-]{0,63}$/', $svc)) {
					$errors[] = _s('%1$s: service "%2$s" may hold only letters, digits, . _ and -.', $label, $svc);
					continue;
				}
				if (!in_array($svc, $roles, true)) {
					$services[] = $svc;
				}
			}
			$services = array_values(array_unique($services));
			sort($services, SORT_NATURAL | SORT_FLAG_CASE);
			$notes = trim((string) ($s['notes'] ?? ''));
			if (mb_strlen($notes) > 2000) {
				$errors[] = _s('%1$s: notes are limited to 2000 characters.', $label);
			}
			$attrs = [];
			foreach ((array) ($s['attrs'] ?? []) as $k => $val) {
				$k = strtolower(trim((string) $k));
				$val = trim((string) $val);
				if ($val === '') {
					continue;
				}
				if (!preg_match('/^[a-z][a-z0-9_]{0,31}$/', $k)) {
					$errors[] = _s('%1$s: attribute "%2$s" may hold only a-z, 0-9 and _.', $label, $k);
					continue;
				}
				if (mb_strlen($val) > 255) {
					$errors[] = _s('%1$s: attribute %2$s is longer than 255 characters.', $label, $k);
					continue;
				}
				$attrs[$k] = $val;
			}
			ksort($attrs);
			$out[$ip] = ['ip' => $ip, 'roles' => $roles, 'services' => $services, 'notes' => $notes, 'attrs' => $attrs];
		}
		uksort($out, fn($a, $b) => ip2long($a) <=> ip2long($b));
		return ['servers' => $out, 'errors' => $errors];
	}

	/** Servers in any order and shape, as the form keeps them: canonical JSON, one way only. */
	public function canonServers(array $servers): string {
		['servers' => $clean] = $this->parseServers(json_encode(array_values($servers)));
		return self::encodeServers($clean);
	}

	/** Checked servers (parseServers) as canonical JSON. */
	public static function encodeServers(array $clean): string {
		return json_encode(array_map(fn($s) => ['ip' => $s['ip'], 'roles' => $s['roles'], 'services' => $s['services'],
			'notes' => $s['notes'], 'attrs' => (object) $s['attrs']], array_values($clean)), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
	}

	/** IPs from a text box or a CSV cell: one per line, or separated by ; , or spaces. */
	public static function splitIps(string $text): array {
		return array_values(array_filter(array_map('trim', preg_split('/[\s;,]+/', $text)), fn($s) => $s !== ''));
	}

	public static function isIPv4(string $s): bool {
		return filter_var($s, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false;
	}

	/** "https://es.acme:9200" → scheme, host, port (9200 when none is given); null when not that shape. */
	public static function esEndpoint(string $url): ?array {
		if (!preg_match('~^(https?)://([A-Za-z0-9.\-]+)(?::(\d{1,5}))?/?$~', $url, $m)) {
			return null;
		}
		return ['scheme' => $m[1], 'host' => $m[2], 'port' => ($m[3] ?? '') !== '' ? $m[3] : '9200'];
	}

	/** "secret/x:key" → [path, key]; null when not that shape. */
	public static function vaultRef(string $ref): ?array {
		$at = strrpos($ref, ':');
		if ($at === false || $at === 0 || $at === strlen($ref) - 1) {
			return null;
		}
		return [substr($ref, 0, $at), substr($ref, $at + 1)];
	}

	/**
	 * "proxy:dc-proxy" → ['proxy', 'dc-proxy'], "group:dc" → ['group', 'dc'], "jump" → ['jump', '']
	 * (Elasticsearch through an SSH jump host, from the Zabbix server); '' → server; null when not that shape.
	 */
	public static function monitoredBy(string $value): ?array {
		if ($value === '') {
			return ['server', ''];
		}
		if ($value === 'jump') {
			return ['jump', ''];
		}
		if (!preg_match('/^(proxy|group):(.{1,128})$/', $value, $m)) {
			return null;
		}
		return [$m[1], trim($m[2])];
	}

	/* ------------------------------------ names ------------------------------------ */

	public static function masterName(string $client): string {
		return $client.'-Master';
	}

	public static function clusterName(string $client): string {
		return $client.'-ES-Cluster';
	}

	public static function ulmName(string $client): string {
		return $client.'-ULM';
	}

	/** A server's host name: <client>-<its roles' names>-<n>. */
	public static function machineName(string $client, string $base, int $n): string {
		return $client.'-'.$base.'-'.$n;
	}

	/** The number in a server's name, when it follows the pattern for this base; null otherwise. */
	public static function slotOf(string $host, string $client, string $base): ?int {
		$prefix = $client.'-'.$base.'-';
		if (strpos($host, $prefix) !== 0) {
			return null;
		}
		$n = substr($host, strlen($prefix));
		return ctype_digit($n) && (int) $n > 0 ? (int) $n : null;
	}

	/* ------------------------------------ macros ------------------------------------ */

	/** The master host's macros: macro => [value, type]. Family mounts follow the roles in use. */
	public function masterMacros(array $client): array {
		$out = ['{$GRP.CLIENT}' => [$client['name'], 0]];
		foreach ($this->macroFields() as $field => $macro) {
			$out[$macro] = [$client['fields'][$field], 0];
		}
		foreach ($this->roles['families'] as $fam) {
			$mounts = $this->familyMounts($client, $fam);
			foreach (MasterTemplate::familyMountMacros($fam['id']) as $i => $macro) {
				$out[$macro] = [$mounts[$i] ?? '', 0];
			}
		}
		return $out;
	}

	/**
	 * The mounts a family's disk is measured on: / and every extra disk of the roles that count
	 * in it and have a server, in role order — at most five.
	 */
	public function familyMounts(array $client, array $family): array {
		$used = [];
		foreach ($client['servers'] as $s) {
			$used = array_merge($used, $s['roles']);
		}
		$out = ['/'];
		foreach (Roles::allRoles($this->roles) as $r) {
			if (!in_array($r['id'], $used, true) || !in_array($family['id'], Roles::familiesOf($r), true)) {
				continue;
			}
			for ($n = 2; $n <= Roles::DISK_SLOTS; $n++) {
				$m = $client['fields'][$r['id'].'_disk'.$n.'_fs'];
				if ($m !== '' && !in_array($m, $out, true) && count($out) < Roles::DISK_SLOTS) {
					$out[] = $m;
				}
			}
		}
		return $out;
	}

	/** A family's requested figure: the sum over the roles that count in it. */
	public function familySum(array $client, array $family, string $suffix): string {
		$sum = 0.0;
		foreach (Roles::allRoles($this->roles) as $r) {
			if (in_array($family['id'], Roles::familiesOf($r), true)) {
				// Disk is / and every extra disk.
				foreach ($suffix === 'disk' ? self::diskFields($r['id']) : [$r['id'].'_'.$suffix] as $field) {
					$sum += (float) $client['fields'][$field];
				}
			}
		}
		return (string) (floor($sum) == $sum ? (int) $sum : $sum);
	}

	/**
	 * The cluster host's macros. The password is written only when there is one to write: a
	 * Vault path (named, or the default for a new host) or a password typed for a Zabbix secret.
	 * Otherwise the host keeps the password it has. Requested figures go per family under the
	 * cluster template's names — memory under both spellings it uses.
	 */
	public function clusterMacros(array $client, bool $new): array {
		$es = $client['es'];
		$out = [
			'{$GRP.CLIENT}' => [$client['name'], 0],
			'{$ELASTICSEARCH.SCHEME}' => [$es['scheme'], 0],
			'{$ELASTICSEARCH.HOST}' => [$es['host'], 0],
			'{$ELASTICSEARCH.PORT}' => [$es['port'], 0],
			'{$ELASTICSEARCH.USERNAME}' => [$client['fields']['es_user'] !== '' ? $client['fields']['es_user'] : 'elastic', 0],
			'{$ES.VOLUME.CUS.PURCHASED}' => [$client['fields']['purchased'], 0],
			'{$EP.DEVICES.PURCHASED}' => [$client['fields']['purchased_devices'], 0]
		];
		$password = $this->passwordMacro($client, $new);
		if ($password !== null) {
			$out['{$ELASTICSEARCH.PASSWORD}'] = $password;
		}
		if ($this->throughJump($client)) {
			$out['{$WJ.HOST}'] = [$client['fields']['jump_host'], 0];
			$out['{$WJ.PORT}'] = [$client['fields']['jump_port'], 0];
			$out['{$WJ.USER}'] = [$client['fields']['jump_user'], 0];
			$out['{$WJ.KEY}'] = [$client['fields']['jump_key'], 0];
			$out['{$WJ.CURL.TLS}'] = [self::curlTls($client['fields']['jump_tls'] ?? 'verify', $client['fields']['jump_ca'] ?? ''), 0];
			$out['{$ES.APIKEY}'] = [$client['fields']['es_apikey_path'], ZBX_MACRO_TYPE_VAULT];
		}
		foreach ($this->roles['families'] as $fam) {
			$p = '{$'.$fam['macroPrefix'].'.';
			$out[$p.'SERVER.COUNT.REQUESTED}'] = [$this->familySum($client, $fam, 'servers'), 0];
			$out[$p.'CPU.REQUESTED}'] = [$this->familySum($client, $fam, 'cpu'), 0];
			$out[$p.'MEMORY.REQUESTED}'] = [$this->familySum($client, $fam, 'mem'), 0];
			$out[$p.'ROOTDISK.REQUESTED}'] = [$this->familySum($client, $fam, 'disk'), 0];
			if (!empty($fam['memAlias'])) {
				$out['{$'.$fam['memAlias'].'}'] = [$this->familySum($client, $fam, 'mem'), 0];
			}
		}
		return $out;
	}

	/** The log archive host's macros; the S3 secret only for an access key, from Vault. */
	public function ulmMacros(array $client, bool $new): array {
		$all = $this->clusterMacros($client, $new);
		$out = array_intersect_key($all, array_flip(['{$GRP.CLIENT}', '{$ELASTICSEARCH.SCHEME}', '{$ELASTICSEARCH.HOST}',
			'{$ELASTICSEARCH.PORT}', '{$ELASTICSEARCH.USERNAME}', '{$ELASTICSEARCH.PASSWORD}']));
		foreach (self::TO_ULM as $macro) {
			$out[$macro] = [$this->masterValue($client, $macro), 0];
		}
		// Behind a jump host the check reads Elasticsearch's answers from this host's SSH items.
		$out['{$ULM.ES.VIA}'] = [$this->throughJump($client) ? 'zabbix' : 'direct', 0];
		if ($this->throughJump($client)) {
			$out += array_intersect_key($all, array_flip(['{$WJ.HOST}', '{$WJ.PORT}', '{$WJ.USER}', '{$WJ.KEY}', '{$WJ.CURL.TLS}', '{$ES.APIKEY}']));
		}
		if ($client['fields']['ulm_auth'] === 'access_key') {
			$ref = $client['fields']['ulm_secret_path'] !== ''
				? $client['fields']['ulm_secret_path']
				: 'secret/elasticpro/'.$client['name'].'-s3:secret_access_key';
			$out['{$ULM.AWS.SECRET.ACCESS.KEY}'] = [$ref, ZBX_MACRO_TYPE_VAULT];
		}
		return $out;
	}

	/** A master macro's value for this client: the form's, or the template default for settings the form does not show. */
	public function masterValue(array $client, string $macro): string {
		$field = array_search($macro, $this->macroFields(), true);
		if ($field !== false) {
			return (string) $client['fields'][$field];
		}
		if (!array_key_exists($macro, $this->defaults)) {
			throw new \LogicException("$macro is handed on but the master template does not define it");
		}
		return (string) $this->defaults[$macro];
	}

	/** A log archive host when there is a bucket; through a jump host its Elasticsearch half runs over SSH. */
	public function wantsUlm(array $client): bool {
		return $client['es'] !== null && $client['fields']['ulm_bucket'] !== self::UNSET_BUCKET;
	}

	/** Elasticsearch reached through an SSH jump host from the Zabbix server. */
	public function throughJump(array $client): bool {
		return $client['fields']['monitored_by'] === 'jump';
	}

	/** [value, type] for the password macro, or null to leave the host's as it is. */
	public function passwordMacro(array $client, bool $new): ?array {
		if ($client['fields']['es_password_mode'] === 'zabbix') {
			return $client['es_password'] !== '' ? [$client['es_password'], ZBX_MACRO_TYPE_SECRET] : null;
		}
		if ($client['fields']['es_password_path'] !== '') {
			return [$client['fields']['es_password_path'], ZBX_MACRO_TYPE_VAULT];
		}
		return $new ? ['secret/elasticpro/'.$client['name'].':password', ZBX_MACRO_TYPE_VAULT] : null;
	}
}
