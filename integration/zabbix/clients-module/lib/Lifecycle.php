<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

use API;
use Exception;

/**
 * A client's status: active, disabled or decommissioned — and maintenance, which is a Zabbix
 * maintenance on the client's host group, read from Zabbix rather than stored.
 *
 * The status is kept in Zabbix, where it survives the data folder: {$EP.CLIENT.STATUS} on the
 * master host and an ep-status tag on every host of the client — both also read under their
 * pre-rename names, and written only under these; see "the old generation" below. Disabling
 * sets every host to Not monitored and marks those that already were (ep-was-off), so enabling
 * turns back on only what it turned off. Decommissioning is only from disabled; the hosts stay, disabled, with their
 * history, until deleted for good.
 */
class Lifecycle {

	public const STATUSES = ['active', 'disabled', 'decommissioned'];
	public const MACRO = '{$EP.CLIENT.STATUS}';
	public const NAME_PREFIX = 'ElasticPro: ';
	/** The status tag every host of the client carries. */
	public const STATUS_TAG = 'ep-status';
	private const WAS_OFF = 'ep-was-off';

	/* -------------------------------- the old generation --------------------------------
	 *
	 * The product was renamed from ElasticVue Pro to ElasticPro and this class's macro, tags and
	 * maintenance names were renamed with it. The production Zabbix still carries the old values on
	 * seven clients and no migration is planned, so they are recognised for good: matched on the
	 * read path, never written, so every host a lifecycle action touches comes out on today's
	 * generation.
	 *
	 * Reading only today's names was not cosmetic. statusOf() returned 'active' for every client
	 * disabled or decommissioned before the rename, because it looked only at {$EP.CLIENT.STATUS}
	 * while the host carried {$EVP.CLIENT.STATUS}. That client could not be moved through its own
	 * lifecycle at all — enable() and decommission() both demand 'disabled' and so refused it —
	 * and worse, AlertRouting asks statusOf() whether a client is decommissioned before it decides
	 * the client wants alerts, so a decommissioned client read as active again.
	 *
	 * The evp-was-off tag was the sharper one: a client disabled before the rename has its
	 * already-off hosts marked evp-was-off, enable() looked only for ep-was-off, found none, and
	 * would have switched on hosts that an operator had deliberately left off — turning monitoring
	 * back on for machines that are not supposed to be monitored.
	 */

	/** Legacy value, kept for recognition: the status macro's name before the rename. */
	public const LEGACY_MACRO = '{$EVP.CLIENT.STATUS}';
	/** Legacy value, kept for recognition: the status tag's name before the rename. */
	public const LEGACY_STATUS_TAG = 'evp-status';
	/** Legacy value, kept for recognition: the already-off marker's name before the rename. */
	private const LEGACY_WAS_OFF = 'evp-was-off';
	/** Legacy value, kept for recognition: the maintenance name prefix before the rename. */
	public const LEGACY_NAME_PREFIX = 'ElasticVue: ';

	/**
	 * Both spellings of both tags this class writes. Stripping all four before writing one set
	 * back is what keeps a host from ending up tagged ep-status=active beside a stale
	 * evp-status=disabled, which would leave the two generations contradicting each other on the
	 * same host and make the client's state depend on which tag a reader happened to look at.
	 */
	private static function ownTags(): array {
		return [self::STATUS_TAG, self::LEGACY_STATUS_TAG, self::WAS_OFF, self::LEGACY_WAS_OFF];
	}

	/** The names a maintenance of this client may carry, today's first. */
	public static function maintenanceNames(string $client): array {
		return [self::NAME_PREFIX.$client, self::LEGACY_NAME_PREFIX.$client];
	}

	/** The client a maintenance of either generation is named after, or null when it is nobody's. */
	public static function clientOfMaintenance(string $name): ?string {
		foreach ([self::NAME_PREFIX, self::LEGACY_NAME_PREFIX] as $prefix) {
			if (strncmp($name, $prefix, strlen($prefix)) === 0) {
				return substr($name, strlen($prefix));
			}
		}
		return null;
	}

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

	/**
	 * The client's status from its master host's macros, under either generation: today's macro
	 * first, the pre-rename macro second, 'active' when neither names a status this class knows.
	 *
	 * It takes the first spelling that holds a *recognised* status rather than the first spelling
	 * that is merely present. That matters on a host carrying both: were an empty or unrecognised
	 * {$EP.CLIENT.STATUS} to win, it would mask a {$EVP.CLIENT.STATUS} of 'decommissioned' and
	 * report a decommissioned client as active, which is exactly what AlertRouting consults this
	 * for before it decides whether to keep the client's alerting. Where both hold a recognised
	 * status, today's wins, so a host part-migrated by hand follows whatever was set last.
	 */
	public static function statusOf(array $macros): string {
		foreach ([self::MACRO, self::LEGACY_MACRO] as $macro) {
			$s = (string) ($macros[$macro] ?? '');
			if (in_array($s, self::STATUSES, true)) {
				return $s;
			}
		}
		return 'active';
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
			$tags = self::without($h['tags'], self::ownTags());
			if ((int) $h['status'] === HOST_STATUS_NOT_MONITORED) {
				$tags[] = ['tag' => self::WAS_OFF, 'value' => '1'];
			}
			else {
				$off++;
			}
			$tags[] = ['tag' => self::STATUS_TAG, 'value' => 'disabled'];
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
			// Both spellings: a client disabled before the rename marked its already-off hosts
			// evp-was-off, and missing that marker switches on a host an operator deliberately left
			// off — the one thing enable() promises not to do.
			$wasOff = (bool) array_filter($h['tags'], fn($t) => in_array($t['tag'], [self::WAS_OFF, self::LEGACY_WAS_OFF], true));
			$tags = array_merge(self::without($h['tags'], self::ownTags()), [['tag' => self::STATUS_TAG, 'value' => 'active']]);
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
		// Both generations: a maintenance started before the rename is called "ElasticVue: <client>",
		// and one this page cannot see is one it reports as absent while it is still suppressing the
		// client's alerts — and endMaintenance() would refuse to end it.
		$names = [];
		foreach ($clients as $c) {
			$names = array_merge($names, self::maintenanceNames($c));
		}
		foreach (API::Maintenance()->get(['output' => ['maintenanceid', 'name', 'active_since', 'active_till', 'maintenance_type', 'description'],
				'filter' => ['name' => $names]]) as $m) {
			if ((int) $m['active_till'] <= time()) {
				continue;
			}
			$client = self::clientOfMaintenance($m['name']);
			// A client can only have one of each generation, and then today's is the one this page
			// last wrote, so it is the one reported.
			if ($client === null || (isset($out[$client]) && strncmp($m['name'], self::NAME_PREFIX, strlen(self::NAME_PREFIX)) !== 0)) {
				continue;
			}
			$out[$client] = ['id' => $m['maintenanceid'], 'since' => (int) $m['active_since'],
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
		// Either generation, so a maintenance started before the rename is replaced rather than
		// joined by a second one: two overlapping maintenances on the same host group both suppress
		// the client's alerts, and ending the one this page knows about would not end the other.
		// Updating it writes $fields, whose name is today's, so it comes back on this generation.
		$existing = API::Maintenance()->get(['output' => ['maintenanceid', 'name'], 'filter' => ['name' => self::maintenanceNames($client)]]);
		usort($existing, fn($a, $b) => (strncmp($b['name'], self::NAME_PREFIX, strlen(self::NAME_PREFIX)) === 0 ? 1 : 0)
			<=> (strncmp($a['name'], self::NAME_PREFIX, strlen(self::NAME_PREFIX)) === 0 ? 1 : 0));
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
		// Every generation, and all of them: "end maintenance" has to leave none behind, or alerts
		// stay suppressed by a maintenance the operator was told had ended. A client can hold two
		// only if one was started before the rename and one after.
		$existing = API::Maintenance()->get(['output' => ['maintenanceid'], 'filter' => ['name' => self::maintenanceNames($client)]]);
		if (!$existing) {
			throw new Exception(_s('Client "%1$s" has no maintenance.', $client));
		}
		$this->api(API::Maintenance()->delete(array_column($existing, 'maintenanceid')), _('end the maintenance'));
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
			// Both spellings of the status tag go, one of today's comes back. The was-off markers are
			// left alone on purpose: decommission() and restore() move between two disabled states, and
			// a later enable() still needs to know which hosts were off before they were disabled.
			$tags = array_merge(self::without($h['tags'], [self::STATUS_TAG, self::LEGACY_STATUS_TAG]),
				[['tag' => self::STATUS_TAG, 'value' => $status]]);
			$this->api(API::Host()->update(['hostid' => $h['hostid'], 'tags' => $tags]), _s('tag "%1$s"', $h['name']));
		}
	}

	/**
	 * Writes the status under today's macro name only. A stale {$EVP.CLIENT.STATUS} is deliberately
	 * left where it is: deleting a macro is a write that cannot be undone, and statusOf() prefers
	 * today's recognised value, so the leftover never decides anything. It also means a rollback to
	 * the pre-rename module would still find the status it understands.
	 */
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
