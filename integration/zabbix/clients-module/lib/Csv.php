<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

/**
 * Clients as two CSV files. Pure — tested on its own (test/spec.test.php).
 *
 *   clients.csv  one row per client: settings and requested capacity per role
 *   servers.csv  one row per server: client, ip, roles (es_data_hot;es_coord), services, notes,
 *                and any other column kept as an attribute of the server (rack, owner …)
 *
 * Either file may come alone. On import a clients.csv column left out means "no change" and an
 * empty cell "clear it". A client in servers.csv gets exactly the servers listed for it; a
 * client not in it keeps its servers.
 */
class Csv {

	/** clients.csv column => form field, for the settings every client has. */
	public const BASE = [
		'client' => 'name',
		'type' => 'type',
		'purchased_by' => 'purchased_by',
		'purchased_storage_gb' => 'purchased',
		'purchased_devices' => 'purchased_devices',
		'es_url' => 'es_url',
		'es_user' => 'es_user',
		'es_password_in' => 'es_password_mode',
		'es_password_vault' => 'es_password_path',
		'monitored_by' => 'monitored_by',
		'jump_host' => 'jump_host',
		'jump_port' => 'jump_port',
		'jump_user' => 'jump_user',
		'jump_key' => 'jump_key',
		'jump_tls' => 'jump_tls',
		'jump_ca' => 'jump_ca',
		'es_apikey_vault' => 'es_apikey_path',
		'soc_lead' => 'lead_name',
		'cluster_dl' => 'cluster_dl',
		'alert_dl' => 'alert_dl',
		'weekly_report' => 'weekly_report',
		'contract_end' => 'contract_end',
		's3_bucket' => 'ulm_bucket',
		's3_region' => 'ulm_region',
		's3_access' => 'ulm_auth',
		's3_role_arn' => 'ulm_role_arn',
		's3_external_id' => 'ulm_external_id',
		's3_access_key_id' => 'ulm_access_key_id',
		's3_secret_vault' => 'ulm_secret_path',
		'raw_folder' => 'ulm_raw_prefix',
		'enriched_folder' => 'ulm_enriched_prefix',
		'agent_port' => 'agent_port'
	];

	/** Per role: clients.csv column suffix => form field suffix. disk_gb is /; disk2 … disk5 are extra disks. */
	public const PER_ROLE = [
		'servers' => 'servers',
		'cpu_cores' => 'cpu',
		'memory_gb' => 'mem',
		'disk_gb' => 'disk',
		'disk2_mount' => 'disk2_fs', 'disk2_gb' => 'disk2',
		'disk3_mount' => 'disk3_fs', 'disk3_gb' => 'disk3',
		'disk4_mount' => 'disk4_fs', 'disk4_gb' => 'disk4',
		'disk5_mount' => 'disk5_fs', 'disk5_gb' => 'disk5'
	];

	/** servers.csv's own columns. Any other column is an attribute. */
	public const SERVER_COLUMNS = ['client', 'ip', 'name', 'roles', 'services', 'notes', 'kind'];

	/** Every clients.csv column, in file order: CSV name => form field. */
	public static function columns(array $roles): array {
		$out = self::BASE;
		foreach (Roles::allRoles($roles) as $r) {
			foreach (self::PER_ROLE as $col => $suffix) {
				$out[$r['id'].'_'.$col] = $r['id'].'_'.$suffix;
			}
		}
		return $out;
	}

	/** clients.csv for these forms. Header only when there are none — the empty template. */
	public static function export(array $roles, array $forms): string {
		$cols = self::columns($roles);
		$rows = [array_keys($cols)];
		foreach ($forms as $form) {
			$row = [];
			foreach ($cols as $field) {
				$v = (string) ($form[$field] ?? '');
				if ($field === 'ulm_auth') {
					$v = $v === 'access_key' ? 'key' : 'role';
				}
				elseif ($field === 'ulm_bucket' && $v === ClientSpec::UNSET_BUCKET) {
					$v = '';
				}
				$row[] = $v;
			}
			$rows[] = $row;
		}
		return self::write($rows);
	}

	/**
	 * servers.csv for these forms: one row per server; attribute columns after the fixed ones.
	 * `name` is the host's name in Zabbix when given (client => ip => name); it is ignored on import.
	 */
	public static function exportServers(array $roles, array $forms, array $hostNames = []): string {
		$attrs = [];
		$lines = [];
		foreach ($forms as $form) {
			foreach ((array) json_decode((string) ($form['servers'] ?? '[]'), true) as $i => $s) {
				$lines[] = [$form['name'], $s];
				foreach ((array) ($s['attrs'] ?? []) as $k => $_) {
					$attrs[$k] = true;
				}
			}
		}
		$attrs = array_keys($attrs);
		sort($attrs);
		$rows = [array_merge(self::SERVER_COLUMNS, $attrs)];
		foreach ($lines as [$client, $s]) {
			$row = [$client, $s['ip'], (string) ($hostNames[$client][$s['ip']] ?? ''),
				implode(';', (array) $s['roles']), implode(';', (array) ($s['services'] ?? [])), (string) ($s['notes'] ?? ''), 'server'];
			foreach ($attrs as $k) {
				$row[] = (string) ($s['attrs'][$k] ?? '');
			}
			$rows[] = $row;
		}
		return self::write($rows);
	}

	private static function write(array $rows): string {
		$fh = fopen('php://temp', 'r+');
		foreach ($rows as $row) {
			// A cell a spreadsheet would run as a formula is written as text.
			fputcsv($fh, array_map(fn($v) => preg_match('/^[=+\-@\t\r]/', (string) $v) && !is_numeric($v) ? "'".$v : $v, $row), ',', '"', '');
		}
		rewind($fh);
		return "\xEF\xBB\xBF".stream_get_contents($fh);
	}

	/** A file as a header and rows. Excel's "CSV UTF-8", or ;-separated. */
	private static function read(string $text): array {
		$text = preg_replace('/^\xEF\xBB\xBF/', '', $text);
		$first = strtok($text, "\r\n");
		$sep = $first !== false && substr_count($first, ';') > substr_count($first, ',') ? ';' : ',';
		$fh = fopen('php://temp', 'r+');
		fwrite($fh, $text);
		rewind($fh);
		$header = fgetcsv($fh, 0, $sep, '"', '');
		if (!$header || $header === [null]) {
			return [null, []];
		}
		$header = array_map(fn($h) => strtolower(trim((string) $h)), $header);
		$rows = [];
		$line = 1;
		while (($cells = fgetcsv($fh, 0, $sep, '"', '')) !== false) {
			$line++;
			if ($cells === [null] || implode('', array_map('trim', $cells)) === '') {
				continue;
			}
			$row = ['_line' => $line];
			foreach ($header as $i => $h) {
				if ($h === '') {
					continue;
				}
				$v = trim((string) ($cells[$i] ?? ''));
				// Undo the formula guard export adds.
				$row[$h] = strpos($v, "'") === 0 && preg_match('/^\'[=+\-@]/', $v) ? substr($v, 1) : $v;
			}
			$rows[] = $row;
		}
		return [$header, $rows];
	}

	private static function duplicates(array $header): array {
		$out = [];
		foreach (array_count_values(array_filter($header)) as $h => $n) {
			if ($n > 1) {
				$out[] = _s('Column "%1$s" appears %2$s times.', $h, $n);
			}
		}
		return $out;
	}

	/**
	 * clients.csv as rows keyed by column. Returns ['columns', 'rows', 'errors', 'ignored'].
	 */
	public static function parse(string $text, array $roles): array {
		$out = ['columns' => [], 'rows' => [], 'errors' => [], 'ignored' => []];
		[$header, $rows] = self::read($text);
		if ($header === null) {
			$out['errors'][] = _('clients.csv is empty.');
			return $out;
		}
		$known = self::columns($roles);
		// An older file's one disk mount per role (<role>_disk_mount) is still read.
		foreach (Roles::allRoles($roles) as $r) {
			$known[$r['id'].'_disk_mount'] = '_legacy';
		}
		$out['ignored'] = array_values(array_filter($header, fn($h) => $h !== '' && !array_key_exists($h, $known)));
		if (!in_array('client', $header, true)) {
			$out['errors'][] = _('clients.csv has no "client" column. Download its template for the columns it expects.');
			return $out;
		}
		$out['errors'] = self::duplicates($header);
		$out['columns'] = array_values(array_filter($header, fn($h) => array_key_exists($h, $known)));
		foreach ($rows as $row) {
			$out['rows'][] = array_intersect_key($row, $known + ['_line' => true]);
		}
		return $out;
	}

	/**
	 * servers.csv, grouped by client: ['clients' => [name => [server, …]], 'errors', 'ignored'].
	 * Roles may be written by id (es_data_hot) or by name (ES Data Hot).
	 */
	public static function parseServers(string $text, array $roles): array {
		$out = ['clients' => [], 'errors' => [], 'ignored' => []];
		[$header, $rows] = self::read($text);
		if ($header === null) {
			$out['errors'][] = _('servers.csv is empty.');
			return $out;
		}
		foreach (['client', 'ip', 'roles'] as $need) {
			if (!in_array($need, $header, true)) {
				$out['errors'][] = _s('servers.csv has no "%1$s" column. Download its template for the columns it expects.', $need);
			}
		}
		$out['errors'] = array_merge($out['errors'], self::duplicates($header));
		if ($out['errors']) {
			return $out;
		}
		$byLabel = [];
		foreach (Roles::allRoles($roles) as $r) {
			$byLabel[strtolower($r['id'])] = $r['id'];
			$byLabel[strtolower($r['label'])] = $r['id'];
			$byLabel[strtolower($r['short'])] = $r['id'];
		}
		$attrCols = array_values(array_filter($header, fn($h) => $h !== '' && !in_array($h, self::SERVER_COLUMNS, true)));
		foreach ($rows as $row) {
			$client = (string) ($row['client'] ?? '');
			if ($client === '') {
				$out['errors'][] = _s('servers.csv line %1$s: no client.', $row['_line']);
				continue;
			}
			$kind = strtolower((string) ($row['kind'] ?? ''));
			if ($kind !== '' && $kind !== 'server') {
				$out['errors'][] = _s('servers.csv line %1$s: kind "%2$s" is not supported yet; only server.', $row['_line'], $row['kind']);
				continue;
			}
			$ids = [];
			foreach (preg_split('/\s*[;|+]\s*/', (string) ($row['roles'] ?? '')) as $name) {
				if (trim($name) === '') {
					continue;
				}
				$ids[] = $byLabel[strtolower(trim($name))] ?? trim($name);
			}
			$attrs = [];
			foreach ($attrCols as $col) {
				$attrs[preg_replace('/[^a-z0-9_]/', '_', $col)] = (string) ($row[$col] ?? '');
			}
			$out['clients'][$client][] = ['ip' => (string) ($row['ip'] ?? ''), 'roles' => $ids,
				'services' => preg_split('/\s*[;,]\s*/', (string) ($row['services'] ?? ''), -1, PREG_SPLIT_NO_EMPTY),
				'notes' => (string) ($row['notes'] ?? ''), 'attrs' => $attrs, '_line' => $row['_line']];
		}
		return $out;
	}

	/** A clients.csv row laid over a client's current form: columns in the file replace, columns not in it keep. */
	public static function toForm(array $row, array $base, array $roles): array {
		$form = $base;
		foreach (self::columns($roles) as $col => $field) {
			if (!array_key_exists($col, $row)) {
				continue;
			}
			$v = $row[$col];
			if ($field === 'ulm_auth') {
				$v = in_array(strtolower($v), ['', 'role', 'role_base', 'iam'], true) ? 'role_base'
					: (in_array(strtolower($v), ['key', 'access_key'], true) ? 'access_key' : $v);
			}
			elseif ($field === 'type') {
				$v = ClientTypes::normalize($v);
			}
			elseif (in_array($field, ['purchased_by', 'es_password_mode'], true)) {
				$v = strtolower($v);
			}
			$form[$field] = $v;
		}
		foreach (Roles::allRoles($roles) as $r) {
			if (array_key_exists($r['id'].'_disk_mount', $row)) {
				$form = ClientSpec::legacyDisk($form, $r['id'], $row[$r['id'].'_disk_mount']);
			}
		}
		return $form;
	}
}
