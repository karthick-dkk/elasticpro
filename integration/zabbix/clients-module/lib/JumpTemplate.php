<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

/**
 * "ElasticPro Elasticsearch via SSH jump host": the cluster figures, for a cluster the
 * Zabbix server can reach only through an SSH jump host (a Windows server with OpenSSH), with no
 * proxy there.
 *
 * The Zabbix server opens an SSH session (an ssh.run item, signed in with its own key) and runs
 * one curl.exe command that asks several Elasticsearch endpoints and prints each answer followed
 * by a marker carrying its HTTP code. JavaScript preprocessing cuts the output at the markers and
 * refuses a part that is not HTTP 200, so a rejected key or a cluster that does not answer is an
 * error naming the endpoint, never a 0. Three sessions per cluster: every minute, every ten
 * minutes, every six hours.
 *
 * Item keys are the HTTP templates' wherever the master template, the reports or the alerts read
 * them (es.nodes.fs.total_in_bytes, es.cluster.status, ep.es.devices.seen …): a client moved to a
 * jump host keeps its figures, reports and history.
 */
class JumpTemplate {

	public const NAME = 'ElasticPro Elasticsearch via SSH jump host';
	public const VERSION = '3';

	/**
	 * Legacy value, kept for recognition: this template's name before the product was renamed
	 * from ElasticVue Pro to ElasticPro. The production Zabbix still carries it, and there will
	 * be no migration, so it is permanent.
	 *
	 * It is matched, never written. Reconciler::current() missing it was not cosmetic: a
	 * pre-rename client behind a jump host was then recognised as having no cluster host at all,
	 * so saving it took the create branch and asked Zabbix for a host called
	 * <client>-ES-Cluster — a name the rename did not change, so one already existed, the create
	 * was refused, and the save threw after the master host had already been retagged and
	 * relinked, leaving the client half-converted with no way back.
	 *
	 * Note for anyone linking this template to a host: the item keys of both generations are the
	 * same on purpose (es.cluster.status, es.nodes.fs.total_in_bytes and the rest are the HTTP
	 * templates', so a client moved onto a jump host keeps its history), so Zabbix will not let
	 * one host carry both at once. The old one has to be unlinked first — "Unlink", never
	 * "Unlink and clear", which would delete the items and every value they hold.
	 */
	public const LEGACY_NAME = 'ElasticVue Pro Elasticsearch via SSH jump host';

	/** The ssh.run keys: one session each. */
	public const FAST = 'ssh.run[ep.fast,{$WJ.HOST},{$WJ.PORT},UTF-8]';
	public const SLOW = 'ssh.run[ep.slow,{$WJ.HOST},{$WJ.PORT},UTF-8]';
	public const DEVICES = 'ssh.run[ep.devices,{$WJ.HOST},{$WJ.PORT},UTF-8]';

	/** What each session asks, in order; the parts of its output follow this order. */
	public const FAST_PATHS = ['/_cluster/health', '/_cluster/stats',
		'/_nodes/stats/jvm,os,fs,thread_pool?filter_path=nodes.*.name,nodes.*.jvm.mem.heap_used_percent,nodes.*.jvm.uptime_in_millis,nodes.*.os.cpu.percent,nodes.*.fs.total,nodes.*.thread_pool.search,nodes.*.thread_pool.write,nodes.*.thread_pool.get'];
	public const SLOW_PATHS = ['/_cat/shards?format=json&h=state,unassigned.reason', '/_cat/indices?format=json&h=health&expand_wildcards=open',
		'/_ilm/status', '/_slm/status', '/_slm/policy', '/_cat/tasks?format=json&h=action,running_time_ns',
		'/_cat/aliases?format=json&h=alias,index,is_write_index', '/_dangling'];

	public static function uuid(string $what): string {
		return MasterTemplate::uuid('jump/'.$what);
	}

	/** The command the jump host runs: curl.exe on Windows 10 1803+ and Server 2019+. */
	public static function command(array $paths, string $extra = ''): string {
		$base = '{$ELASTICSEARCH.SCHEME}://{$ELASTICSEARCH.HOST}:{$ELASTICSEARCH.PORT}';
		return 'curl.exe -s {$WJ.CURL.TLS} --max-time 25 -H "Authorization: ApiKey {$ES.APIKEY}" -w "\n@@HTTP %{http_code}@@\n"'.$extra.' '
			.implode(' ', array_map(fn($p) => '"'.$base.$p.'"', $paths));
	}

	/**
	 * A step that takes part `$n` of the output and refuses anything but HTTP 200, naming the
	 * endpoint. Output with no marker at all means curl.exe never ran on the jump host. The code
	 * is cluster-steps.json's, which the tests run.
	 */
	public static function partStep(int $n, array $paths): string {
		return str_replace(['__N__', '__PATHS__'], [(string) $n, self::pathsJs($paths)], DevicesTemplate::js('jump_part'));
	}

	/** Every non-200 answer in the output, in words; empty when all were 200. */
	public static function problemStep(array $paths): string {
		return str_replace('__PATHS__', self::pathsJs($paths), DevicesTemplate::js('jump_problem'));
	}

	private static function pathsJs(array $paths): string {
		return json_encode(array_map(fn($p) => explode('?', $p)[0], $paths), JSON_UNESCAPED_SLASHES);
	}

	private static function ssh(string $key, string $name, string $command, string $delay): array {
		return [
			'uuid' => self::uuid('item/'.$key),
			'name' => $name,
			'type' => 'SSH',
			'key' => $key,
			'delay' => $delay,
			'history' => '1h',
			'value_type' => 'TEXT',
			'trends' => '0',
			'timeout' => '60s',
			'authtype' => 'PUBLIC_KEY',
			'username' => '{$WJ.USER}',
			'publickey' => '{$WJ.KEY}.pub',
			'privatekey' => '{$WJ.KEY}',
			'params' => $command,
			'description' => 'Runs on the jump host over SSH. Raw answers; the figures below are read from them.',
			'tags' => [['tag' => 'component', 'value' => 'raw']]
		];
	}

	private static function figure(string $master, int $part, array $paths, string $key, string $name, string $type, array $steps, string $units = '', array $extra = []): array {
		$pre = [['type' => 'JAVASCRIPT', 'parameters' => [self::partStep($part, $paths)]]];
		foreach ($steps as $s) {
			$pre[] = $s[0] === 'jsonpath' ? ['type' => 'JSONPATH', 'parameters' => [$s[1]]]
				: ($s[0] === 'js' ? ['type' => 'JAVASCRIPT', 'parameters' => [$s[1]]] : ['type' => $s[0], 'parameters' => $s[1]]);
		}
		$item = ['uuid' => self::uuid('item/'.$key), 'name' => $name, 'type' => 'DEPENDENT', 'key' => $key, 'delay' => '0',
			'value_type' => $type, 'preprocessing' => $pre, 'master_item' => ['key' => $master],
			'tags' => [['tag' => 'component', 'value' => 'elasticsearch']]];
		if (in_array($type, ['TEXT', 'CHAR'], true)) {
			$item['trends'] = '0';
		}
		if ($units !== '') {
			$item['units'] = $units;
		}
		return $item + $extra;
	}

	/** The log archive check's Elasticsearch half, through the jump host, for a client's ULM host. */
	public const ULM_NAME = 'ElasticPro log archive ES via SSH jump host';
	/**
	 * Legacy value, kept for recognition: the log archive half's name before the rename. Matched
	 * only, like LEGACY_NAME, and for the same reason — the live install was never migrated. Its
	 * two ssh.run keys did change with the rename (evp.ulm.days became ep.ulm.days), so the two
	 * generations of this one do not collide on a host; the figures read from them do not carry
	 * across either, which is why the old one is left alone rather than cleared.
	 */
	public const LEGACY_ULM_NAME = 'ElasticVue Pro log archive ES via SSH jump host';
	public const ULM_DAYS = 'ssh.run[ep.ulm.days,{$WJ.HOST},{$WJ.PORT},UTF-8]';
	public const ULM_TAGS = 'ssh.run[ep.ulm.tags,{$WJ.HOST},{$WJ.PORT},UTF-8]';

	/**
	 * The two searches the log archive check (ulm-check.js: discover() and esDays()) makes, with
	 * the ULM host's macros in place of the values it reads: which tag1 values were logged, and
	 * which tag x branch x day has logs. Through a jump host the branch field is required.
	 */
	public const ULM_TAGS_QUERY = '{"size":0,"query":{"bool":{"filter":[{"range":{"{$ULM.ES.TIME.FIELD}":{"gte":"now-{$ULM.DISCOVERY.DAYS}d"}}}]}},'
		.'"aggs":{"tags":{"terms":{"field":"{$ULM.ES.TAG.FIELD}","size":1000}}}}';
	public const ULM_DAYS_QUERY = '{"size":0,"query":{"bool":{"filter":[{"range":{"{$ULM.ES.TIME.FIELD}":{"gte":"now-{$ULM.LOOKBACK.HOURS}h","lte":"now-{$ULM.GRACE.MINUTES}m"}}}]}},'
		.'"aggs":{"tags":{"terms":{"field":"{$ULM.ES.TAG.FIELD}","size":1000},"aggs":{"branches":{"terms":{"field":"{$ULM.ES.BRANCH.FIELD}","size":200},'
		.'"aggs":{"days":{"date_histogram":{"field":"{$ULM.ES.TIME.FIELD}","calendar_interval":"day","time_zone":"{$ULM.TIMEZONE}","min_doc_count":1,"format":"yyyy.M.d"}}}}}}}}';

	private static function ulmSearch(string $query): string {
		return self::command(['/{$ULM.ES.INDEX}/_search?ignore_unavailable=true&allow_no_indices=true'],
			' -H "Content-Type: application/json" -d "'.str_replace('"', '\\"', $query).'"');
	}

	/**
	 * Linked beside "ElasticPro log archive S3" on a client's ULM host when the cluster is
	 * behind a jump host: the check reads these answers from the Zabbix API ({$ULM.ES.VIA} = zabbix).
	 */
	public static function ulmExport(): array {
		$T = self::ULM_NAME;
		$items = [
			self::ssh(self::ULM_DAYS, 'Log archive: which tag, branch and day Elasticsearch holds (through the jump host)', self::ulmSearch(self::ULM_DAYS_QUERY), '1h'),
			self::ssh(self::ULM_TAGS, 'Log archive: tag1 values logged (through the jump host)', self::ulmSearch(self::ULM_TAGS_QUERY), '1d')
		];
		foreach ($items as &$it) {
			$it['uuid'] = self::uuid('ulm/'.$it['key']);
			$it['history'] = '2d';
			$it['description'] = 'Read by the log archive check from the Zabbix API; asks nothing of S3.';
		}
		unset($it);
		return ['zabbix_export' => [
			'version' => '7.0',
			'templates' => [[
				'uuid' => self::uuid('ulm/template'),
				'template' => $T,
				'name' => $T,
				'description' => 'The log archive check\'s Elasticsearch half for a cluster behind a Windows jump host. Linked by Cluster Management to the client\'s ULM host, beside the log archive template.',
				'vendor' => ['name' => 'ElasticPro', 'version' => '7.0-'.self::VERSION],
				'groups' => [['name' => 'Templates/Applications']],
				'items' => $items,
				'macros' => [
					['macro' => '{$WJ.HOST}', 'value' => '', 'description' => 'Jump host address. Set by Cluster Management.'],
					['macro' => '{$WJ.PORT}', 'value' => '22', 'description' => 'Jump host SSH port.'],
					['macro' => '{$WJ.USER}', 'value' => '', 'description' => 'SSH user on the jump host.'],
					['macro' => '{$WJ.KEY}', 'value' => 'id_ed25519', 'description' => 'Private key file in the Zabbix server\'s SSH key folder.'],
					['macro' => '{$WJ.CURL.TLS}', 'value' => '', 'description' => 'curl.exe certificate options. Set by Cluster Management.'],
					['macro' => '{$ES.APIKEY}', 'type' => 'SECRET_TEXT', 'value' => '', 'description' => 'Read-only Elasticsearch API key; needs read on the log indices. Set by Cluster Management, from Vault.']
				]
			]]
		]];
	}

	private static function trigger(string $id, string $expression, string $name, string $priority, string $description): array {
		return ['uuid' => self::uuid('trigger/'.$id), 'expression' => $expression, 'name' => $name, 'priority' => $priority,
			'description' => $description, 'tags' => [['tag' => 'scope', 'value' => 'elasticsearch']]];
	}

	public static function export(): array {
		$T = self::NAME;
		$F = self::FAST_PATHS;
		$S = self::SLOW_PATHS;
		$js = fn($k) => ['js', DevicesTemplate::js($k)];
		$f = fn(string $key, string $name, string $type, array $steps, string $units = '', array $extra = []) => self::figure(self::FAST, self::partOf($key), $F, $key, $name, $type, $steps, $units, $extra);
		$items = [];

		$items[] = self::ssh(self::FAST, 'Elasticsearch through the jump host: health, stats, nodes', self::command($F), '1m');
		$items[] = self::ssh(self::SLOW, 'Elasticsearch through the jump host: shards, indices, ILM, SLM, tasks', self::command($S), '10m');
		$items[] = self::ssh(self::DEVICES, 'Elasticsearch through the jump host: device count', self::command(['/{$EP.DEVICE.INDEX}/_search?ignore_unavailable=true&allow_no_indices=true'],
			' -H "Content-Type: application/json" -d "'.str_replace('"', '\\"', DevicesTemplate::QUERY).'"'), '6h');

		// Whether every answer was 200: the one place a rejected key or a silent cluster is said.
		foreach ([[self::FAST, $F, 'fast'], [self::SLOW, $S, 'slow']] as [$m, $paths, $id]) {
			$items[] = ['uuid' => self::uuid('item/problem/'.$id), 'name' => 'Elasticsearch through the jump host: failed answers ('.$id.')', 'type' => 'DEPENDENT',
				'key' => 'ep.wj.problem['.$id.']', 'delay' => '0', 'value_type' => 'TEXT', 'trends' => '0', 'master_item' => ['key' => $m],
				'preprocessing' => [['type' => 'JAVASCRIPT', 'parameters' => [self::problemStep($paths)]]],
				'tags' => [['tag' => 'component', 'value' => 'jump']],
				'triggers' => [self::trigger('problem/'.$id, 'length(last(/'.$T.'/ep.wj.problem['.$id.']))>0',
					'{$GRP.CLIENT}: Elasticsearch through the jump host: {ITEM.LASTVALUE1}', 'HIGH',
					'The jump host answered, but Elasticsearch refused or did not answer: a rejected API key (401/403), or the cluster unreachable from the jump host.')]];
		}

		// Health.
		$status = "var s = JSON.parse(value).status; return s === 'green' ? 0 : s === 'yellow' ? 1 : s === 'red' ? 2 : 255;";
		$items[] = $f('es.cluster.status', 'Cluster health status', 'UNSIGNED', [['js', $status]], '', ['valuemap' => ['name' => 'ES cluster state'], 'triggers' => [
			self::trigger('red', 'last(/'.$T.'/es.cluster.status)=2', '{$GRP.CLIENT}: cluster health is RED', 'HIGH', 'At least one primary shard is not allocated: some data cannot be searched or written.'),
			self::trigger('yellow', 'last(/'.$T.'/es.cluster.status)=1', '{$GRP.CLIENT}: cluster health is YELLOW', 'WARNING', 'All primaries are allocated, some replicas are not.')]]);
		foreach ([['number_of_nodes', 'Number of nodes'], ['number_of_data_nodes', 'Number of data nodes'], ['relocating_shards', 'Relocating shards'],
				['initializing_shards', 'Initializing shards'], ['unassigned_shards', 'Unassigned shards'], ['delayed_unassigned_shards', 'Delayed unassigned shards'],
				['number_of_pending_tasks', 'Pending tasks']] as [$k, $n]) {
			$extra = $k === 'unassigned_shards' ? ['triggers' => [self::trigger('unassigned', 'min(/'.$T.'/es.cluster.unassigned_shards,30m)>0',
				'{$GRP.CLIENT}: {ITEM.LASTVALUE1} shards unassigned for 30 minutes', 'WARNING', 'Shards the cluster has not placed for half an hour.')]] : [];
			$items[] = $f('es.cluster.'.$k, $n, 'UNSIGNED', [['jsonpath', '$.'.$k]], '', $extra);
		}
		$items[] = $f('es.cluster.inactive_shards_percent_as_number', 'Inactive shards percentage', 'FLOAT', [['jsonpath', '$.active_shards_percent_as_number'],
			['js', 'return 100 - Number(value);']], '%');
		$items[] = $f('ep.es.shards.active_primary', 'Active primary shards', 'UNSIGNED', [['jsonpath', '$.active_primary_shards']]);
		$items[] = $f('ep.es.shards.active', 'Active shards', 'UNSIGNED', [['jsonpath', '$.active_shards']]);

		// Cluster stats: storage (the master template reads these keys), documents, versions.
		$items[] = $f('es.nodes.fs.total_in_bytes', 'Total size of all file stores', 'UNSIGNED', [['jsonpath', '$.nodes.fs.total_in_bytes']], 'B');
		$items[] = $f('es.nodes.fs.available_in_bytes', 'Available size of all file stores', 'UNSIGNED', [['jsonpath', '$.nodes.fs.available_in_bytes']], 'B');
		$items[] = $f('es.nodes.fs.used_in_bytes', 'Used size of all file stores', 'UNSIGNED', [['js', "var fs = JSON.parse(value).nodes.fs; return fs.total_in_bytes - fs.available_in_bytes;"]], 'B');
		$items[] = ['uuid' => self::uuid('item/pused'), 'name' => 'Used share of all file stores', 'type' => 'CALCULATED', 'key' => 'es.nodes.fs.pused_in_bytes', 'delay' => '1m',
			'value_type' => 'FLOAT', 'units' => '%', 'params' => '100*last(//es.nodes.fs.used_in_bytes)/last(//es.nodes.fs.total_in_bytes)',
			'tags' => [['tag' => 'component', 'value' => 'elasticsearch']], 'triggers' => [
				self::trigger('disk.high', 'last(/'.$T.'/es.nodes.fs.pused_in_bytes)>={$EP.USAGE.HIGH}', '{$GRP.CLIENT}: ES storage {ITEM.LASTVALUE1} used', 'HIGH', 'Above the high threshold.'),
				self::trigger('disk.warn', 'last(/'.$T.'/es.nodes.fs.pused_in_bytes)>={$EP.USAGE.WARN} and last(/'.$T.'/es.nodes.fs.pused_in_bytes)<{$EP.USAGE.HIGH}',
					'{$GRP.CLIENT}: ES storage {ITEM.LASTVALUE1} used', 'WARNING', 'Above the warning threshold.')]];
		$items[] = $f('es.indices.count', 'Number of indices', 'UNSIGNED', [['jsonpath', '$.indices.count']]);
		$items[] = $f('es.indices.docs.count', 'Number of documents', 'UNSIGNED', [['jsonpath', '$.indices.docs.count']]);
		$items[] = $f('es.version', 'Elasticsearch version', 'CHAR', [['jsonpath', '$.nodes.versions[0]']]);
		$items[] = $f('es.jdk.version', 'JDK version', 'CHAR', [['jsonpath', '$.nodes.jvm.versions[0].version']]);
		$items[] = $f('es.nodes.jvm.max_uptime', 'Cluster uptime', 'UNSIGNED', [['jsonpath', '$.nodes.jvm.max_uptime_in_millis'], ['MULTIPLIER', ['0.001']]], 's');

		// Node stats: CPU, heap, the thread pools that reject work.
		$items[] = $f('ep.es.nodes.cpu.max', 'Node CPU, busiest node', 'FLOAT', [$js('cpu_max')], '%');
		$items[] = $f('ep.es.nodes.cpu.avg', 'Node CPU, average', 'FLOAT', [$js('cpu_avg')], '%');
		$items[] = $f('ep.es.nodes.heap.max', 'JVM heap, fullest node', 'FLOAT', [['js', "var n = JSON.parse(value).nodes || {}, max = -1;\nfor (var k in n) { if (!n.hasOwnProperty(k)) continue; var h = ((n[k].jvm || {}).mem || {}).heap_used_percent; if (typeof h === 'number' && h > max) max = h; }\nif (max < 0) throw 'no node reported its heap';\nreturn max;"]], '%',
			['triggers' => [self::trigger('heap', 'min(/'.$T.'/ep.es.nodes.heap.max,10m)>90', '{$GRP.CLIENT}: JVM heap above 90 % on a node for 10 minutes', 'AVERAGE', 'A node near its heap limit collects garbage constantly and slows every request.')]]);
		foreach (['search', 'write', 'get'] as $pool) {
			$sum = "var n = JSON.parse(value).nodes || {}, q = 0, r = 0;\nfor (var k in n) { if (!n.hasOwnProperty(k)) continue; var p = (n[k].thread_pool || {})['$pool'] || {}; q += p.queue || 0; r += p.rejected || 0; }\nreturn ";
			$items[] = $f('ep.es.thread_pool.'.$pool.'.queue', ucfirst($pool).' thread pool: tasks in queue', 'UNSIGNED', [['js', $sum.'q;']]);
			$items[] = $f('ep.es.thread_pool.'.$pool.'.rejected.rate', ucfirst($pool).' thread pool: tasks rejected', 'FLOAT', [['js', $sum.'r;'], ['CHANGE_PER_SECOND', ['']]], 'rps');
		}

		// The ten-minute session: the same figures, and the same steps, as the HTTP extras template.
		$s = fn(int $part, string $key, string $name, string $type, array $steps, string $units = '', array $extra = []) => self::figure(self::SLOW, $part, $S, $key, $name, $type, $steps, $units, $extra);
		$items[] = $s(0, 'ep.es.shards.unassigned_reasons', 'Unassigned shards by reason', 'TEXT', [$js('unassigned_by_reason')]);
		$items[] = $s(1, 'ep.es.indices.red', 'Red indices', 'UNSIGNED', [$js('indices_red')], '', ['triggers' => [self::trigger('indices.red', 'last(/'.$T.'/ep.es.indices.red)>0',
			'{$GRP.CLIENT}: {ITEM.LASTVALUE1} red indices', 'HIGH', 'At least one index has a primary shard unassigned.')]]);
		$items[] = $s(1, 'ep.es.indices.yellow', 'Yellow indices', 'UNSIGNED', [$js('indices_yellow')]);
		$items[] = $s(2, 'ep.es.ilm.mode', 'ILM operation mode', 'CHAR', [['jsonpath', '$.operation_mode']], '', ['triggers' => [self::trigger('ilm', 'last(/'.$T.'/ep.es.ilm.mode)<>"RUNNING"',
			'{$GRP.CLIENT}: ILM is {ITEM.LASTVALUE1}', 'WARNING', 'Index lifecycle management is not running.')]]);
		$items[] = $s(3, 'ep.es.slm.mode', 'SLM operation mode', 'CHAR', [['jsonpath', '$.operation_mode']], '', ['triggers' => [self::trigger('slm', 'last(/'.$T.'/ep.es.slm.mode)<>"RUNNING"',
			'{$GRP.CLIENT}: SLM is {ITEM.LASTVALUE1}', 'WARNING', 'Snapshot lifecycle management is not running.')]]);
		$items[] = $s(4, 'ep.es.slm.policies', 'SLM policies', 'UNSIGNED', [$js('slm_policies')]);
		$items[] = $s(4, 'ep.es.slm.last_success_age', 'Age of the last good snapshot', 'UNSIGNED', [$js('slm_last_success_age')], 's');
		$items[] = $s(5, 'ep.es.tasks.long', 'Long-running tasks', 'UNSIGNED', [$js('tasks_long')]);
		$items[] = $s(6, 'ep.es.aliases.no_write_index', 'Rollover aliases without a write index', 'UNSIGNED', [$js('aliases_no_write')], '', ['triggers' => [self::trigger('aliases',
			'last(/'.$T.'/ep.es.aliases.no_write_index)>0', '{$GRP.CLIENT}: {ITEM.LASTVALUE1} aliases have no write index', 'AVERAGE', 'Anything writing through such an alias fails.')]]);
		$items[] = $s(7, 'ep.es.indices.dangling', 'Dangling indices', 'UNSIGNED', [$js('dangling')], '', ['triggers' => [self::trigger('dangling',
			'last(/'.$T.'/ep.es.indices.dangling)>0', '{$GRP.CLIENT}: {ITEM.LASTVALUE1} dangling indices', 'WARNING', 'Index data on disk the cluster does not know about.')]]);

		// Devices, every six hours.
		$items[] = self::figure(self::DEVICES, 0, ['/{$EP.DEVICE.INDEX}/_search'], DevicesTemplate::KEY, 'Devices seen in the last {$EP.DEVICE.WINDOW}', 'UNSIGNED',
			[['jsonpath', '$.aggregations.devices.value']], '', ['triggers' => [
				self::trigger('devices.over', '{$EP.DEVICES.PURCHASED}>0 and last(/'.$T.'/'.DevicesTemplate::KEY.')>{$EP.DEVICES.PURCHASED}',
					'{$GRP.CLIENT}: more devices than purchased', 'AVERAGE', 'More distinct devices sent logs than the client purchased.'),
				self::trigger('devices.drop', 'last(/'.$T.'/'.DevicesTemplate::KEY.',#5)>0 and last(/'.$T.'/'.DevicesTemplate::KEY.')<0.5*last(/'.$T.'/'.DevicesTemplate::KEY.',#5)',
					'{$GRP.CLIENT}: devices sending logs halved in a day', 'WARNING', 'Fewer than half the devices of 24 hours ago sent logs.')]]);

		// The per-node figures, from the nodes this minute's answer names.
		$nodeFind = fn(string $expr) => "var n = JSON.parse(value).nodes || {};\nfor (var k in n) if (n.hasOwnProperty(k) && n[k].name === '{#ES.NODE}') return $expr;\nthrow 'node {#ES.NODE} did not answer';";
		$proto = fn(string $key, string $name, string $type, string $expr, string $units = '') => ['uuid' => self::uuid('proto/'.$key), 'name' => 'ES {#ES.NODE}: '.$name,
			'type' => 'DEPENDENT', 'key' => $key.'[{#ES.NODE}]', 'delay' => '0', 'value_type' => $type, 'units' => $units, 'master_item' => ['key' => self::FAST],
			'preprocessing' => [['type' => 'JAVASCRIPT', 'parameters' => [self::partStep(2, $F)]], ['type' => 'JAVASCRIPT', 'parameters' => [$nodeFind($expr)]]],
			'tags' => [['tag' => 'component', 'value' => 'node'], ['tag' => 'node', 'value' => '{#ES.NODE}']]];
		$discovery = [[
			'uuid' => self::uuid('lld/nodes'),
			'name' => 'Elasticsearch nodes through the jump host',
			'type' => 'DEPENDENT',
			'key' => 'ep.wj.nodes.discovery',
			'delay' => '0',
			'lifetime' => '7d',
			'master_item' => ['key' => self::FAST],
			'preprocessing' => [
				['type' => 'JAVASCRIPT', 'parameters' => [self::partStep(2, $F)]],
				['type' => 'JAVASCRIPT', 'parameters' => ["var n = JSON.parse(value).nodes || {}, out = [];\nfor (var k in n) if (n.hasOwnProperty(k)) out.push({ '{#ES.NODE}': n[k].name, '{#ES.NODE.ID}': k });\nreturn JSON.stringify(out);"]],
				['type' => 'DISCARD_UNCHANGED_HEARTBEAT', 'parameters' => ['1h']]
			],
			'item_prototypes' => [
				$proto('es.node.jvm.mem.heap_used_percent', 'percent of JVM heap in use', 'FLOAT', "n[k].jvm.mem.heap_used_percent", '%'),
				$proto('es.node.jvm.uptime', 'node uptime', 'UNSIGNED', "Math.round(n[k].jvm.uptime_in_millis / 1000)", 's'),
				$proto('ep.es.node.cpu', 'CPU', 'FLOAT', "n[k].os.cpu.percent", '%'),
				$proto('es.node.fs.total.total_in_bytes', 'total size', 'UNSIGNED', "n[k].fs.total.total_in_bytes", 'B'),
				$proto('es.node.fs.total.available_in_bytes', 'total available size', 'UNSIGNED', "n[k].fs.total.available_in_bytes", 'B')
			]
		]];

		return ['zabbix_export' => [
			'version' => '7.0',
			'templates' => [[
				'uuid' => self::uuid('template'),
				'template' => $T,
				'name' => $T,
				'description' => 'Elasticsearch through an SSH jump host (Windows with OpenSSH and curl.exe), asked by the Zabbix server with no proxy. Linked by Cluster Management to a client\'s cluster host instead of the HTTP templates.',
				'vendor' => ['name' => 'ElasticPro', 'version' => '7.0-'.self::VERSION],
				'groups' => [['name' => 'Templates/Applications']],
				'items' => $items,
				'discovery_rules' => $discovery,
				'macros' => [
					['macro' => '{$WJ.HOST}', 'value' => '', 'description' => 'Jump host address, as the Zabbix server reaches it. Set by Cluster Management.'],
					['macro' => '{$WJ.PORT}', 'value' => '22', 'description' => 'Jump host SSH port.'],
					['macro' => '{$WJ.USER}', 'value' => '', 'description' => 'SSH user on the jump host.'],
					['macro' => '{$WJ.CURL.TLS}', 'value' => '', 'description' => 'curl.exe certificate options: empty checks the cluster\'s certificate with the Windows trust store; --cacert "C:\\path\\ca.pem" with a CA file; -k not at all. Set by Cluster Management.'],
					['macro' => '{$WJ.KEY}', 'value' => 'id_ed25519', 'description' => 'Private key file in the Zabbix server\'s SSH key folder; its .pub beside it.'],
					['macro' => '{$ES.APIKEY}', 'type' => 'SECRET_TEXT', 'value' => '', 'description' => 'Read-only Elasticsearch API key (monitor). Set by Cluster Management, from Vault.'],
					['macro' => '{$EP.DEVICE.FIELD}', 'value' => 'src_hostname', 'description' => 'The field naming the device (a keyword field).'],
					['macro' => '{$EP.DEVICE.WINDOW}', 'value' => '24h', 'description' => 'How far back a device counts.'],
					['macro' => '{$EP.DEVICE.INDEX}', 'value' => 'logstash-*', 'description' => 'Indices holding the logs.'],
					['macro' => '{$EP.DEVICE.TIME.FIELD}', 'value' => '@timestamp', 'description' => 'The time a log arrived.'],
					['macro' => '{$EP.DEVICES.PURCHASED}', 'value' => '0', 'description' => 'Devices the client purchased. Set by Cluster Management.'],
					['macro' => '{$EP.TASK.LONG}', 'value' => '300', 'description' => 'A task running longer than this many seconds counts as long-running.'],
					['macro' => '{$EP.USAGE.WARN}', 'value' => '80', 'description' => 'Storage used at or above this is a warning.'],
					['macro' => '{$EP.USAGE.HIGH}', 'value' => '90', 'description' => 'Storage used at or above this is high.'],
					['macro' => '{$EP.JUMP.VERSION}', 'value' => self::VERSION, 'description' => 'Which version of this template is written. Set by Cluster Management.']
				],
				'valuemaps' => [[
					'uuid' => self::uuid('valuemap/state'),
					'name' => 'ES cluster state',
					'mappings' => [['value' => '0', 'newvalue' => 'green'], ['value' => '1', 'newvalue' => 'yellow'], ['value' => '2', 'newvalue' => 'red'], ['value' => '255', 'newvalue' => 'unknown']]
				]]
			]],
			'triggers' => [[
				'uuid' => self::uuid('trigger/nodata'),
				'expression' => 'nodata(/'.$T.'/'.self::FAST.',5m)=1',
				'name' => '{$GRP.CLIENT}: no answer through the jump host for 5 minutes',
				'priority' => 'HIGH',
				'description' => 'The Zabbix server could not run the check on the jump host: SSH refused (key not in authorized_keys, wrong user), the jump host unreachable, or curl.exe missing. The item\'s error in Latest data says which.',
				'tags' => [['tag' => 'scope', 'value' => 'jump']]
			]]
		]];
	}

	/** Which part of the one-minute answer a figure reads: health 0, stats 1, nodes 2. */
	private static function partOf(string $key): int {
		if (strpos($key, 'es.cluster.') === 0 || strpos($key, 'ep.es.shards.active') === 0) {
			return 0;
		}
		if (strpos($key, 'es.nodes.fs.') === 0 || strpos($key, 'es.indices.') === 0 || in_array($key, ['es.version', 'es.jdk.version', 'es.nodes.jvm.max_uptime'], true)) {
			return 1;
		}
		return 2;
	}
}
