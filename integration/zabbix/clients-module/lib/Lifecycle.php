<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

use API;
use Exception;

/**
 * A client's status: active, disabled or decommissioned — and maintenance, which is a Zabbix
 * maintenance on the client's host group, read from Zabbix rather than stored.
 *
 * The status is kept in Zabbix, where it survives the data folder: {$EP.CLIENT.STATUS} on the
 * master host and an ep-status tag on every host of the client. Disabling sets every host to
 * Not monitored and marks those that already were (ep-was-off), so enabling turns back on only
 * what it turned off. Decommissioning is only from disabled; the hosts stay, disabled, with their
 * history, until deleted for good.
 */
class Lifecycle {

	public const STATUSES = ['active', 'disabled', 'decommissioned'];
	public const MACRO = '{$EP.CLIENT.STATUS}';
	public const NAME_PREFIX = 'ElasticPro: ';
	private const WAS_OFF = 'ep-was-off';

	/** @var Reconciler */
	private $rec;
	/** @var string[] */
	private $done = [];

	public function __construct(Reconciler $rec) {
		$this->rec = $rec;
	}

	public function done(): array {
		return $this->done;
	}

	public static function statusOf(array $macros): string {
		$s = (string) ($macros[self::MACRO] ?? 'active');
		return in_array($s, self::STATUSES, true) ? $s : 'active';
	}

	/** Every host of the client: master, cluster, archive, servers, and hosts with no role. */
	private function hosts(array $now): array {
		$out = [];
		foreach (array_merge(array_filter([$now['master'], $now['cluster'], $now['ulm']]), array_values($now['machines'])) as $h) {
			$out[$h['hostid']] = $h;
		}
		if ($now['groupid'] !== null) {
			foreach ($this->rec->hostsIn($now['groupid']) as $h) {
				$out[$h['hostid']] = $out[$h['hostid']] ?? $h;
			}
		}
		// hostsIn has status and tags; the master found outside the group may not.
		$ids = array_keys($out);
		return $ids ? API::Host()->get(['output' => ['hostid', 'name', 'status'], 'hostids' => $ids, 'selectTags' => ['tag', 'value'], 'preservekeys' => true]) : [];
	}

	public function status(string $client): string {
		$now = $this->rec->current($client);
		return $now['master'] !== null ? self::statusOf($this->rec->macros($now['master']['hostid'])) : 'active';
	}

	public function disable(string $client): void {
		$now = $this->needClient($client);
		if ($this->status($client) !== 'active') {
			throw new Exception(_s('Client "%1$s" is not active.', $client));
		}
		$off = 0;
		foreach ($this->hosts($now) as $h) {
			$tags = self::without($h['tags'], ['ep-status', self::WAS_OFF]);
			if ((int) $h['status'] === HOST_STATUS_NOT_MONITORED) {
				$tags[] = ['tag' => self::WAS_OFF, 'value' => '1'];
			}
			else {
				$off++;
			}
			$tags[] = ['tag' => 'ep-status', 'value' => 'disabled'];
			$this->api(API::Host()->update(['hostid' => $h['hostid'], 'status' => HOST_STATUS_NOT_MONITORED, 'tags' => $tags]), _s('disable "%1$s"', $h['name']));
		}
		$this->setStatus($now, 'disabled');
		$this->done[] = _n('%1$s host set to Not monitored.', '%1$s hosts set to Not monitored.', $off);
	}

	public function enable(string $client): void {
		$now = $this->needClient($client);
		if ($this->status($client) !== 'disabled') {
			throw new Exception(_s('Client "%1$s" is not disabled.', $client));
		}
		$on = 0;
		foreach ($this->hosts($now) as $h) {
			$wasOff = (bool) array_filter($h['tags'], fn($t) => $t['tag'] === self::WAS_OFF);
			$tags = array_merge(self::without($h['tags'], ['ep-status', self::WAS_OFF]), [['tag' => 'ep-status', 'value' => 'active']]);
			$update = ['hostid' => $h['hostid'], 'tags' => $tags];
			if (!$wasOff) {
				$update['status'] = HOST_STATUS_MONITORED;
				$on++;
			}
			$this->api(API::Host()->update($update), _s('enable "%1$s"', $h['name']));
		}
		$this->setStatus($now, 'active');
		$this->done[] = _n('%1$s host monitored again; hosts that were off before stay off.', '%1$s hosts monitored again; hosts that were off before stay off.', $on);
	}

	public function decommission(string $client): void {
		$now = $this->needClient($client);
		if ($this->status($client) !== 'disabled') {
			throw new Exception(_s('Only a disabled client can be decommissioned: disable "%1$s" first.', $client));
		}
		$this->retag($now, 'decommissioned');
		$this->setStatus($now, 'decommissioned');
		$this->done[] = _('Its hosts stay, not monitored, with their history.');
	}

	public function restore(string $client): void {
		$now = $this->needClient($client);
		if ($this->status($client) !== 'decommissioned') {
			throw new Exception(_s('Client "%1$s" is not decommissioned.', $client));
		}
		$this->retag($now, 'disabled');
		$this->setStatus($now, 'disabled');
		$this->done[] = _('Back to disabled: enable it to monitor it again.');
	}

	/* ------------------------------------ maintenance ------------------------------------ */

	/** The client's maintenance in Zabbix, when there is one still to end: {id, since, till, collect, reason}. */
	public static function maintenances(array $clients): array {
		if (!$clients) {
			return [];
		}
		$out = [];
		$names = array_map(fn($c) => self::NAME_PREFIX.$c, $clients);
		foreach (API::Maintenance()->get(['output' => ['maintenanceid', 'name', 'active_since', 'active_till', 'maintenance_type', 'description'],
				'filter' => ['name' => $names]]) as $m) {
			if ((int) $m['active_till'] <= time()) {
				continue;
			}
			$out[substr($m['name'], strlen(self::NAME_PREFIX))] = ['id' => $m['maintenanceid'], 'since' => (int) $m['active_since'],
				'till' => (int) $m['active_till'], 'collect' => (int) $m['maintenance_type'] === MAINTENANCE_TYPE_NORMAL, 'reason' => $m['description']];
		}
		return $out;
	}

	/** Start (or replace) the client's maintenance: from `$since`, for `$seconds`. */
	public function startMaintenance(string $client, int $since, int $seconds, bool $collect, string $reason): void {
		$now = $this->needClient($client);
		if ($this->status($client) !== 'active') {
			throw new Exception(_s('Client "%1$s" is not active: maintenance is for monitored clients.', $client));
		}
		if ($seconds < 300 || $seconds > 30 * 86400) {
			throw new Exception(_('Maintenance lasts from 5 minutes to 30 days.'));
		}
		$since = max($since, time() - 60);
		$fields = [
			'name' => self::NAME_PREFIX.$client,
			'active_since' => $since,
			'active_till' => $since + $seconds,
			'maintenance_type' => $collect ? MAINTENANCE_TYPE_NORMAL : MAINTENANCE_TYPE_NODATA,
			'description' => mb_substr($reason, 0, 1024),
			'groups' => [['groupid' => $now['groupid']]],
			'timeperiods' => [['timeperiod_type' => TIMEPERIOD_TYPE_ONETIME, 'start_date' => $since, 'period' => $seconds]]
		];
		$existing = API::Maintenance()->get(['output' => ['maintenanceid'], 'filter' => ['name' => self::NAME_PREFIX.$client]]);
		if ($existing) {
			$this->api(API::Maintenance()->update(['maintenanceid' => $existing[0]['maintenanceid']] + $fields), _('update the maintenance'));
		}
		else {
			$this->api(API::Maintenance()->create($fields), _('create the maintenance'));
		}
		$this->done[] = _s('Zabbix maintenance "%1$s" from %2$s to %3$s, %4$s.', self::NAME_PREFIX.$client, date('d M H:i', $since),
			date('d M H:i', $since + $seconds), $collect ? _('data still collected') : _('no data collected'));
	}

	public function endMaintenance(string $client): void {
		$existing = API::Maintenance()->get(['output' => ['maintenanceid'], 'filter' => ['name' => self::NAME_PREFIX.$client]]);
		if (!$existing) {
			throw new Exception(_s('Client "%1$s" has no maintenance.', $client));
		}
		$this->api(API::Maintenance()->delete([$existing[0]['maintenanceid']]), _('end the maintenance'));
		$this->done[] = _('Maintenance ended.');
	}

	/* ------------------------------------ helpers ------------------------------------ */

	private function needClient(string $client): array {
		$now = $this->rec->current($client);
		if ($now['master'] === null || $now['groupid'] === null) {
			throw new Exception(_s('Client "%1$s" has no master host in Zabbix.', $client));
		}
		return $now;
	}

	private function retag(array $now, string $status): void {
		foreach ($this->hosts($now) as $h) {
			$tags = array_merge(self::without($h['tags'], ['ep-status']), [['tag' => 'ep-status', 'value' => $status]]);
			$this->api(API::Host()->update(['hostid' => $h['hostid'], 'tags' => $tags]), _s('tag "%1$s"', $h['name']));
		}
	}

	private function setStatus(array $now, string $status): void {
		$hostid = $now['master']['hostid'];
		$have = API::UserMacro()->get(['output' => ['hostmacroid'], 'hostids' => [$hostid], 'filter' => ['macro' => self::MACRO]]);
		$this->api($have
			? API::UserMacro()->update(['hostmacroid' => $have[0]['hostmacroid'], 'value' => $status])
			: API::UserMacro()->create(['hostid' => $hostid, 'macro' => self::MACRO, 'value' => $status]), _('save the status'));
	}

	private static function without(array $tags, array $names): array {
		return array_values(array_map(fn($t) => ['tag' => $t['tag'], 'value' => $t['value']],
			array_filter($tags, fn($t) => !in_array($t['tag'], $names, true))));
	}

	private function api($result, string $what) {
		if ($result === false) {
			$said = array_column(get_and_clear_messages(), 'message');
			throw new Exception(_s('Zabbix would not %1$s: %2$s', $what, implode(' ', $said) ?: _('no reason given')));
		}
		return $result;
	}
}
