<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

use API;
use Exception;

/**
 * A client's problems by email to its cluster DL, and only its own. Three Zabbix objects, all
 * named after the client and made and removed by the page:
 *   - user group "ElasticPro: <client>": read on the client's host group, no frontend access;
 *   - user "ep-dl-<client>": no password anyone knows, one Email media — the DL;
 *   - trigger action "ElasticPro: <client>": problems on the client's host group to that group,
 *     recovery to whoever was told. Paused while the problem is suppressed, so a maintenance
 *     silences it.
 * On when the client asks for it ({$EP.ALERT.DL} = 1) and has a DL; removed otherwise, and when
 * the client is decommissioned or deleted.
 *
 * The weekly report ({$EP.REPORT.WEEKLY} = 1) uses the same group: a dashboard "ElasticPro:
 * <client>" with Client resources, Client capacity and Volume report for the client's host group,
 * and a Zabbix scheduled report mailing it as PDF each Monday at 08:00 for the week before.
 * Needs Zabbix's web service (the stack runs one) and its Frontend URL set.
 */
class AlertRouting {

	public const NAME_PREFIX = 'ElasticPro: ';
	/** Warning, Average, High, Disaster. */
	public const SEVERITIES = 60;

	public static function userName(string $client): string {
		return 'ep-dl-'.substr(preg_replace('/[^A-Za-z0-9._-]+/', '-', $client), 0, 90);
	}

	/** Whether a client, by its master host's macros, wants its problems sent to its DL. */
	public static function wanted(array $macros): bool {
		return ($macros['{$EP.ALERT.DL}'] ?? '0') === '1' && trim((string) ($macros['{$EP.DL}'] ?? '')) !== ''
			&& Lifecycle::statusOf($macros) !== 'decommissioned';
	}

	public static function reportWanted(array $macros): bool {
		return ($macros['{$EP.REPORT.WEEKLY}'] ?? '0') === '1' && trim((string) ($macros['{$EP.DL}'] ?? '')) !== ''
			&& Lifecycle::statusOf($macros) !== 'decommissioned';
	}

	/** The widgets of a client's report dashboard, each for the client's host group only. */
	public const REPORT_WIDGETS = [['ep_resources', 0, 6], ['ep_capacity', 6, 4], ['ep_volume', 10, 5]];

	/** The weekly report's dashboard and schedule as API parameters. */
	public static function reportPlan(string $client, string $groupid, string $usrgrpid, string $owner): array {
		return [
			'dashboard' => [
				'name' => self::NAME_PREFIX.$client,
				'userGroups' => [['usrgrpid' => $usrgrpid, 'permission' => PERM_READ]],
				'pages' => [['widgets' => array_map(fn($w) => ['type' => $w[0], 'x' => 0, 'y' => $w[1], 'width' => 72, 'height' => $w[2],
					'fields' => [['type' => ZBX_WIDGET_FIELD_TYPE_GROUP, 'name' => 'groupids.0', 'value' => $groupid]]], self::REPORT_WIDGETS)]]
			],
			'report' => [
				'userid' => $owner,
				'name' => self::NAME_PREFIX.$client.' weekly',
				'period' => ZBX_REPORT_PERIOD_WEEK,
				'cycle' => ZBX_REPORT_CYCLE_WEEKLY,
				'weekdays' => 1,
				'start_time' => 8 * 3600,
				'status' => ZBX_REPORT_STATUS_ENABLED,
				'subject' => $client.': weekly report',
				'message' => 'Capacity, storage and log delay of '.$client.' for the past week. Sent by Zabbix for Cluster Management.',
				'user_groups' => [['usrgrpid' => $usrgrpid, 'access_userid' => $owner]]
			]
		];
	}

	/** The three objects as Zabbix API parameters (without ids that do not exist yet). */
	public static function plan(string $client, string $groupid, string $dl, string $mediatypeid): array {
		return [
			'usergroup' => [
				'name' => self::NAME_PREFIX.$client,
				'gui_access' => GROUP_GUI_ACCESS_DISABLED,
				'hostgroup_rights' => [['id' => $groupid, 'permission' => PERM_READ]]
			],
			'media' => [['mediatypeid' => $mediatypeid, 'sendto' => [$dl], 'active' => MEDIA_STATUS_ACTIVE,
				'severity' => self::SEVERITIES, 'period' => '1-7,00:00-24:00']],
			'action' => [
				'name' => self::NAME_PREFIX.$client,
				'eventsource' => EVENT_SOURCE_TRIGGERS,
				'status' => ACTION_STATUS_ENABLED,
				'esc_period' => '1h',
				'pause_suppressed' => ACTION_PAUSE_SUPPRESSED_TRUE,
				'filter' => ['evaltype' => CONDITION_EVAL_TYPE_AND_OR, 'conditions' => [
					['conditiontype' => ZBX_CONDITION_TYPE_HOST_GROUP, 'operator' => CONDITION_OPERATOR_EQUAL, 'value' => $groupid]
				]],
				'recovery_operations' => [['operationtype' => OPERATION_TYPE_RECOVERY_MESSAGE, 'opmessage' => ['default_msg' => 1]]]
			]
		];
	}

	/**
	 * Make Zabbix match: the three objects when wanted, none otherwise. Returns what it did, in
	 * words. Throws when routing is wanted but Zabbix has no active Email media type.
	 */
	public static function sync(string $client, ?string $groupid, array $macros, string $owner = ''): array {
		$name = self::NAME_PREFIX.$client;
		$done = self::syncReport($client, $groupid, $macros, $owner, false);
		$group = API::UserGroup()->get(['output' => ['usrgrpid'], 'filter' => ['name' => $name]])[0] ?? null;
		$user = API::User()->get(['output' => ['userid'], 'filter' => ['username' => self::userName($client)], 'selectMedias' => ['mediaid']])[0] ?? null;
		$action = API::Action()->get(['output' => ['actionid'], 'filter' => ['name' => $name]])[0] ?? null;
		$alerts = self::wanted($macros) && $groupid !== null;
		$report = self::reportWanted($macros) && $groupid !== null;

		if (!$alerts && $action) {
			self::api(API::Action()->delete([$action['actionid']]), _('remove the DL alert routing'));
			$done[] = _('Problems are no longer emailed to the cluster DL.');
		}
		if (!$alerts && !$report) {
			if ($user) { self::api(API::User()->delete([$user['userid']]), _('remove the DL account')); }
			if ($group) { self::api(API::UserGroup()->delete([$group['usrgrpid']]), _('remove the DL user group')); }
			return $done;
		}

		$email = API::MediaType()->get(['output' => ['mediatypeid'], 'filter' => ['type' => MEDIA_TYPE_EMAIL, 'status' => MEDIA_TYPE_STATUS_ACTIVE]])[0] ?? null;
		if ($email === null) {
			throw new Exception(_('Problems cannot be emailed: Zabbix has no active Email media type (Alerts → Media types).'));
		}
		$dl = trim((string) $macros['{$EP.DL}']);
		$p = self::plan($client, (string) $groupid, $dl, $email['mediatypeid']);

		if ($group) {
			self::api(API::UserGroup()->update(['usrgrpid' => $group['usrgrpid']] + $p['usergroup']), _('update the DL user group'));
			$gid = $group['usrgrpid'];
		}
		else {
			$gid = self::api(API::UserGroup()->create($p['usergroup']), _('create the DL user group'))['usrgrpids'][0];
		}
		if ($user) {
			self::api(API::User()->update(['userid' => $user['userid'], 'usrgrps' => [['usrgrpid' => $gid]], 'medias' => $p['media']]), _('update the DL user'));
		}
		else {
			$role = API::Role()->get(['output' => ['roleid'], 'filter' => ['type' => USER_TYPE_ZABBIX_USER], 'sortfield' => 'roleid', 'limit' => 1])[0] ?? null;
			if ($role === null) {
				throw new Exception(_('Problems cannot be emailed: Zabbix has no User role for the DL\'s account.'));
			}
			self::api(API::User()->create(['username' => self::userName($client), 'name' => $client, 'surname' => 'cluster DL',
				'passwd' => 'Ep!'.bin2hex(random_bytes(16)).'Zz9', 'roleid' => $role['roleid'],
				'usrgrps' => [['usrgrpid' => $gid]], 'medias' => $p['media']]), _('create the DL user'));
		}
		if ($report) {
			$done = array_merge($done, self::syncReport($client, $groupid, $macros, $owner, true, $gid));
		}
		if (!$alerts) {
			return $done;
		}
		$ops = ['operations' => [['operationtype' => OPERATION_TYPE_MESSAGE, 'opmessage' => ['default_msg' => 1], 'opmessage_grp' => [['usrgrpid' => $gid]]]]];
		if ($action) {
			self::api(API::Action()->update(['actionid' => $action['actionid']] + array_diff_key($p['action'], ['eventsource' => 1]) + $ops), _('update the DL action'));
		}
		else {
			self::api(API::Action()->create($p['action'] + $ops), _('create the DL action'));
		}
		$done[] = _s('Problems (warning and above) are emailed to %1$s; not during maintenance.', $dl);
		return $done;
	}

	/**
	 * The weekly report: removed when not wanted (first pass, before the DL group can go), made or
	 * brought up to date when wanted (second pass, once the group exists). The dashboard is deleted
	 * only while it holds nothing but the page's own widgets.
	 */
	private static function syncReport(string $client, ?string $groupid, array $macros, string $owner, bool $make, string $gid = ''): array {
		$name = self::NAME_PREFIX.$client;
		$report = API::Report()->get(['output' => ['reportid'], 'filter' => ['name' => $name.' weekly']])[0] ?? null;
		$board = API::Dashboard()->get(['output' => ['dashboardid'], 'filter' => ['name' => $name], 'selectPages' => ['widgets']])[0] ?? null;
		$wanted = self::reportWanted($macros) && $groupid !== null;
		if (!$make) {
			if ($wanted) {
				return [];
			}
			$said = [];
			if ($report) {
				self::api(API::Report()->delete([$report['reportid']]), _('remove the weekly report'));
				$said[] = _('The weekly report is no longer sent.');
			}
			$ours = $board !== null && array_diff(array_merge(...array_map(fn($p) => array_column($p['widgets'], 'type'), $board['pages'])),
				array_column(self::REPORT_WIDGETS, 0)) === [];
			if ($ours) {
				self::api(API::Dashboard()->delete([$board['dashboardid']]), _('remove the report dashboard'));
			}
			return $said;
		}
		$p = self::reportPlan($client, (string) $groupid, $gid, $owner);
		if ($board) {
			self::api(API::Dashboard()->update(['dashboardid' => $board['dashboardid'], 'userGroups' => $p['dashboard']['userGroups']]), _('share the report dashboard'));
			$boardid = $board['dashboardid'];
		}
		else {
			$boardid = self::api(API::Dashboard()->create($p['dashboard']), _('create the report dashboard'))['dashboardids'][0];
		}
		if ($report) {
			self::api(API::Report()->update(['reportid' => $report['reportid'], 'dashboardid' => $boardid] + array_diff_key($p['report'], ['userid' => 1])), _('update the weekly report'));
		}
		else {
			self::api(API::Report()->create(['dashboardid' => $boardid] + $p['report']), _('create the weekly report'));
		}
		return [_s('The weekly report (dashboard "%1$s") is mailed to %2$s each Monday at 08:00.', $name, trim((string) $macros['{$EP.DL}']))];
	}

	private static function api($result, string $what) {
		if ($result === false) {
			$said = array_column(get_and_clear_messages(), 'message');
			throw new Exception(_s('Zabbix would not %1$s: %2$s', $what, implode(' ', $said) ?: _('no reason given')));
		}
		return $result;
	}
}
