<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

/**
 * "ElasticPro cluster devices": how many distinct devices sent logs, asked of the cluster
 * every 6 hours — and the figures ElasticPro shows that the Elasticsearch template does not
 * collect: active primary and total shards, why shards are unassigned, red and yellow indices,
 * ILM and SLM run mode, SLM policies and the age of the last good snapshot, the get thread pool,
 * CPU as Elasticsearch reports it, dangling indices, long-running tasks and rollover aliases
 * without a write index. Linked to each client's cluster host beside the Elasticsearch
 * template, so it reaches the cluster the same way — its address, user, password and proxy.
 *
 * Each figure is read from one request (a master item) by dependent items; a request that
 * fails leaves its figures unsupported with Elasticsearch's reason — unknown, never 0.
 *
 * Elasticsearch counts distinct values exactly up to precision_threshold (40,000). A cluster
 * that cannot answer leaves the item unsupported with Elasticsearch's reason: unknown, not 0.
 */
class DevicesTemplate {

	public const NAME = Roles::TEMPLATE_SLOTS['devices'][0];

	/** The name this template is installed and linked under; see MasterTemplate::name(). */
	public static function name(): string {
		return Roles::templateName('devices');
	}
	public const KEY = 'ep.es.devices.seen';
	/** Raised when the template changes, so the Clients page offers to write it again. */
	public const VERSION = '2';

	public static function uuid(string $what): string {
		return MasterTemplate::uuid('devices/'.$what);
	}

	/** The device-count search. The jump host template sends the same body. */
	public const QUERY = '{"size":0,"track_total_hits":false,'
		.'"query":{"range":{"{$EP.DEVICE.TIME.FIELD}":{"gte":"now-{$EP.DEVICE.WINDOW}"}}},'
		.'"aggs":{"devices":{"cardinality":{"field":"{$EP.DEVICE.FIELD}","precision_threshold":40000}}}}';

	public static function export(): array {
		$T = self::NAME;
		$body = self::QUERY;
		return ['zabbix_export' => [
			'version' => '7.0',
			'templates' => [[
				'uuid' => self::uuid('template'),
				'template' => $T,
				// The technical name stays, so hosts already linked keep the template.
				'name' => 'ElasticPro cluster devices and extras',
				'description' => 'Distinct devices with logs every 6 hours, and the cluster figures ElasticPro shows beyond the Elasticsearch template. Linked by the Clients page to each client\'s cluster host.',
				'vendor' => ['name' => 'ElasticPro', 'version' => '7.0-'.self::VERSION],
				'groups' => [['name' => 'Templates/Applications']],
				'items' => array_merge([[
					'uuid' => self::uuid('item/seen'),
					'name' => 'Devices seen in the last {$EP.DEVICE.WINDOW}',
					'type' => 'HTTP_AGENT',
					'key' => self::KEY,
					'delay' => '6h',
					'value_type' => 'UNSIGNED',
					'timeout' => '60s',
					'url' => '{$ELASTICSEARCH.SCHEME}://{$ELASTICSEARCH.HOST}:{$ELASTICSEARCH.PORT}/{$EP.DEVICE.INDEX}/_search?ignore_unavailable=true&allow_no_indices=true',
					'request_method' => 'POST',
					'post_type' => 'JSON',
					'posts' => $body,
					'headers' => [['name' => 'Content-Type', 'value' => 'application/json']],
					'authtype' => 'BASIC',
					'username' => '{$ELASTICSEARCH.USERNAME}',
					'password' => '{$ELASTICSEARCH.PASSWORD}',
					// Elasticsearch's own error is the useful message; let it through to the step below.
					'status_codes' => '200,400,401,403,404,500,503',
					'description' => 'Distinct {$EP.DEVICE.FIELD} values with logs in {$EP.DEVICE.INDEX} over the last {$EP.DEVICE.WINDOW}.',
					'preprocessing' => [
						['type' => 'CHECK_JSON_ERROR', 'parameters' => ['$.error.reason']],
						['type' => 'JSONPATH', 'parameters' => ['$.aggregations.devices.value']]
					],
					'tags' => [['tag' => 'component', 'value' => 'devices']],
					'triggers' => [
						[
							'uuid' => self::uuid('trigger/over'),
							'expression' => '{$EP.DEVICES.PURCHASED}>0 and last(/'.$T.'/'.self::KEY.')>{$EP.DEVICES.PURCHASED}',
							'name' => '{$GRP.CLIENT}: more devices than purchased',
							'event_name' => '{$GRP.CLIENT}: {ITEM.LASTVALUE1} devices seen, {$EP.DEVICES.PURCHASED} purchased',
							'priority' => 'AVERAGE',
							'description' => 'The cluster received logs from more distinct devices than the client purchased.',
							'tags' => [['tag' => 'scope', 'value' => 'capacity']]
						],
						[
							'uuid' => self::uuid('trigger/drop'),
							'expression' => 'last(/'.$T.'/'.self::KEY.',#5)>0 and last(/'.$T.'/'.self::KEY.')<0.5*last(/'.$T.'/'.self::KEY.',#5)',
							'name' => '{$GRP.CLIENT}: devices sending logs halved in a day',
							'event_name' => '{$GRP.CLIENT}: {ITEM.LASTVALUE1} devices seen, half of a day before',
							'priority' => 'WARNING',
							'description' => 'Fewer than half the devices of 24 hours ago (four checks back) sent logs. A source may have gone quiet.',
							'tags' => [['tag' => 'scope', 'value' => 'devices']]
						]
					]
				]], self::extras()),
				'macros' => [
					['macro' => '{$EP.DEVICE.FIELD}', 'value' => 'src_hostname', 'description' => 'The field naming the device. Must be a keyword field (e.g. src_hostname or src_hostname.keyword).'],
					['macro' => '{$EP.DEVICE.WINDOW}', 'value' => '24h', 'description' => 'How far back a device counts.'],
					['macro' => '{$EP.DEVICE.INDEX}', 'value' => 'logstash-*', 'description' => 'Indices holding the logs.'],
					['macro' => '{$EP.DEVICE.TIME.FIELD}', 'value' => '@timestamp', 'description' => 'The time a log arrived.'],
					['macro' => '{$EP.DEVICES.PURCHASED}', 'value' => '0', 'description' => 'Devices the client purchased. Set by the Clients page.'],
					['macro' => '{$EP.TASK.LONG}', 'value' => '300', 'description' => 'A task running longer than this many seconds counts as long-running.'],
					['macro' => '{$EP.DEVICES.VERSION}', 'value' => self::VERSION, 'description' => 'Which version of this template is written. Set by the Clients page.']
				]
			]]
		]];
	}

	/* ------------------------------ the extra figures ------------------------------ */

	/** A GET request to the cluster, as the master of the figures read from it. */
	private static function master(string $key, string $name, string $path, string $delay): array {
		return [
			'uuid' => self::uuid('item/'.$key),
			'name' => 'Get '.$name,
			'type' => 'HTTP_AGENT',
			'key' => $key,
			'delay' => $delay,
			'history' => '1h',
			'value_type' => 'TEXT',
			'trends' => '0',
			'timeout' => '30s',
			'url' => '{$ELASTICSEARCH.SCHEME}://{$ELASTICSEARCH.HOST}:{$ELASTICSEARCH.PORT}'.$path,
			'authtype' => 'BASIC',
			'username' => '{$ELASTICSEARCH.USERNAME}',
			'password' => '{$ELASTICSEARCH.PASSWORD}',
			'status_codes' => '200,400,401,403,404,500,503',
			// A failed request carries Elasticsearch's reason; it becomes the figures' error.
			'preprocessing' => [['type' => 'CHECK_JSON_ERROR', 'parameters' => ['$.error.reason']]],
			'description' => 'Raw answer; the figures below are read from it.',
			'tags' => [['tag' => 'component', 'value' => 'raw']]
		];
	}

	/** A figure read from a master item: by JSONPath, or by a short JavaScript step (ES5). */
	private static function figure(string $master, string $key, string $name, string $type, array $step, string $units = '', string $description = '', array $extra = []): array {
		$pre = $step[0] === 'jsonpath'
			? [['type' => 'JSONPATH', 'parameters' => [$step[1]]]]
			: [['type' => 'JAVASCRIPT', 'parameters' => [$step[1]]]];
		foreach ($step[2] ?? [] as $more) {
			$pre[] = $more;
		}
		$item = [
			'uuid' => self::uuid('item/'.$key),
			'name' => $name,
			'type' => 'DEPENDENT',
			'key' => $key,
			'delay' => '0',
			'value_type' => $type,
			'preprocessing' => $pre,
			'master_item' => ['key' => $master],
			'description' => $description,
			'tags' => [['tag' => 'component', 'value' => 'cluster']]
		];
		if ($type === 'TEXT' || $type === 'CHAR') {
			$item['trends'] = '0';
		}
		if ($units !== '') {
			$item['units'] = $units;
		}
		return $item + $extra;
	}

	private static function trigger(string $id, string $expression, string $name, string $priority, string $description): array {
		return ['uuid' => self::uuid('trigger/'.$id), 'expression' => $expression, 'name' => $name, 'priority' => $priority,
			'description' => $description, 'tags' => [['tag' => 'scope', 'value' => 'elasticsearch']]];
	}

	/** The JavaScript steps, from cluster-steps.json — one copy, which the tests also run. */
	public static function js(string $name): string {
		static $steps = null;
		$steps = $steps ?? json_decode((string) file_get_contents(__DIR__.'/cluster-steps.json'), true)['steps'];
		return $steps[$name];
	}


	private static function extras(): array {
		$T = self::NAME;
		$js = fn($k) => ['js', self::js($k)];
		$out = [];

		$out[] = self::master('ep.es.raw.health', 'cluster health', '/_cluster/health', '5m');
		$out[] = self::figure('ep.es.raw.health', 'ep.es.shards.active_primary', 'Active primary shards', 'UNSIGNED', ['jsonpath', '$.active_primary_shards']);
		$out[] = self::figure('ep.es.raw.health', 'ep.es.shards.active', 'Active shards', 'UNSIGNED', ['jsonpath', '$.active_shards']);

		$out[] = self::master('ep.es.raw.shards', 'shard states', '/_cat/shards?format=json&h=state,unassigned.reason', '10m');
		$out[] = self::figure('ep.es.raw.shards', 'ep.es.shards.unassigned_reasons', 'Unassigned shards by reason', 'TEXT', $js('unassigned_by_reason'), '',
			'Why shards are unassigned, most common first (INDEX_CREATED, NODE_LEFT, ALLOCATION_FAILED …).');

		$out[] = self::master('ep.es.raw.indices', 'index health', '/_cat/indices?format=json&h=health&expand_wildcards=open', '10m');
		$out[] = self::figure('ep.es.raw.indices', 'ep.es.indices.red', 'Red indices', 'UNSIGNED', $js('indices_red'), '', '', ['triggers' => [
			self::trigger('indices.red', 'last(/'.$T.'/ep.es.indices.red)>0', '{$GRP.CLIENT}: {ITEM.LASTVALUE1} red indices', 'HIGH',
				'At least one index has a primary shard unassigned: part of its data cannot be searched or written.')]]);
		$out[] = self::figure('ep.es.raw.indices', 'ep.es.indices.yellow', 'Yellow indices', 'UNSIGNED', $js('indices_yellow'));

		$out[] = self::master('ep.es.raw.ilm', 'ILM status', '/_ilm/status', '10m');
		$out[] = self::figure('ep.es.raw.ilm', 'ep.es.ilm.mode', 'ILM operation mode', 'CHAR', ['jsonpath', '$.operation_mode'], '', '', ['triggers' => [
			self::trigger('ilm.mode', 'last(/'.$T.'/ep.es.ilm.mode)<>"RUNNING"', '{$GRP.CLIENT}: ILM is {ITEM.LASTVALUE1}', 'WARNING',
				'Index lifecycle management is not running: indices are not rolled over, moved or deleted on schedule.')]]);

		$out[] = self::master('ep.es.raw.slm_status', 'SLM status', '/_slm/status', '10m');
		$out[] = self::figure('ep.es.raw.slm_status', 'ep.es.slm.mode', 'SLM operation mode', 'CHAR', ['jsonpath', '$.operation_mode'], '', '', ['triggers' => [
			self::trigger('slm.mode', 'last(/'.$T.'/ep.es.slm.mode)<>"RUNNING"', '{$GRP.CLIENT}: SLM is {ITEM.LASTVALUE1}', 'WARNING',
				'Snapshot lifecycle management is not running: scheduled snapshots are not taken.')]]);

		$out[] = self::master('ep.es.raw.slm_policy', 'SLM policies', '/_slm/policy', '30m');
		$out[] = self::figure('ep.es.raw.slm_policy', 'ep.es.slm.policies', 'SLM policies', 'UNSIGNED', $js('slm_policies'));
		$out[] = self::figure('ep.es.raw.slm_policy', 'ep.es.slm.last_success_age', 'Age of the last good snapshot', 'UNSIGNED', $js('slm_last_success_age'), 's',
			'Since the newest successful snapshot of any SLM policy. Unknown when no policy has one.');

		$out[] = self::master('ep.es.raw.thread_pool', 'get thread pool', '/_cat/thread_pool/get?format=json&h=node_name,name,queue,rejected', '5m');
		$out[] = self::figure('ep.es.raw.thread_pool', 'ep.es.thread_pool.get.queue', 'Get thread pool: tasks in queue', 'UNSIGNED', $js('tp_get_queue'));
		$out[] = self::figure('ep.es.raw.thread_pool', 'ep.es.thread_pool.get.rejected.rate', 'Get thread pool: tasks rejected', 'FLOAT', ['js', self::js('tp_get_rejected'),
			[['type' => 'CHANGE_PER_SECOND', 'parameters' => ['']]]], 'rps', 'Across all nodes. Rejected gets are failed reads.');

		$out[] = self::master('ep.es.raw.nodes_os', 'node CPU', '/_nodes/stats/os?filter_path=nodes.*.os.cpu.percent', '5m');
		$out[] = self::figure('ep.es.raw.nodes_os', 'ep.es.nodes.cpu.max', 'Node CPU, busiest node', 'FLOAT', $js('cpu_max'), '%', 'As Elasticsearch reports it (os.cpu.percent).');
		$out[] = self::figure('ep.es.raw.nodes_os', 'ep.es.nodes.cpu.avg', 'Node CPU, average', 'FLOAT', $js('cpu_avg'), '%');

		$out[] = self::master('ep.es.raw.dangling', 'dangling indices', '/_dangling', '1h');
		$out[] = self::figure('ep.es.raw.dangling', 'ep.es.indices.dangling', 'Dangling indices', 'UNSIGNED', $js('dangling'), '', '', ['triggers' => [
			self::trigger('dangling', 'last(/'.$T.'/ep.es.indices.dangling)>0', '{$GRP.CLIENT}: {ITEM.LASTVALUE1} dangling indices', 'WARNING',
				'Index data on disk that the cluster does not know about — usually left by a node that rejoined. It takes disk and may be data someone expects to find.')]]);

		$out[] = self::master('ep.es.raw.tasks', 'running tasks', '/_cat/tasks?format=json&h=action,running_time_ns', '5m');
		$out[] = self::figure('ep.es.raw.tasks', 'ep.es.tasks.long', 'Long-running tasks', 'UNSIGNED', $js('tasks_long'), '',
			'Tasks running longer than {$EP.TASK.LONG} seconds.');

		$out[] = self::master('ep.es.raw.aliases', 'aliases', '/_cat/aliases?format=json&h=alias,index,is_write_index', '30m');
		$out[] = self::figure('ep.es.raw.aliases', 'ep.es.aliases.no_write_index', 'Rollover aliases without a write index', 'UNSIGNED', $js('aliases_no_write'), '', '', ['triggers' => [
			self::trigger('aliases', 'last(/'.$T.'/ep.es.aliases.no_write_index)>0', '{$GRP.CLIENT}: {ITEM.LASTVALUE1} aliases have no write index', 'AVERAGE',
				'An alias over several indices with none marked as the write index: anything writing through it fails.')]]);
		return $out;
	}
}
