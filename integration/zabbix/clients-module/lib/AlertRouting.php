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
 * On when the client asks for it ({$EP.ALERT.DL} = 1) and has a DL; removed when the client's own
 * macros say so, and when it is decommissioned.
 *
 * Removal needs the macros to say it, never merely to be silent. sync() therefore does nothing at
 * all — no create, no update, no delete — when it cannot see the client's host group or when the
 * client's settings are of the generation this page reads but does not write; unsafe() names the
 * data that went with reading those two silences as "wants no alerting". One consequence is worth
 * knowing: a client that really has been deleted reaches sync() with no host group, so its user
 * group, DL account, trigger action, weekly report and dashboard are now left behind and named in
 * the notice for an operator to remove by hand. That is the cheaper of the two mistakes — a
 * leftover can be deleted, a deleted trigger action with its escalation steps cannot be rebuilt —
 * but it is not free: deleting a client for good leaves its host group standing, so a host someone
 * made there by hand can still raise a problem that this action emails to the DL of a client that
 * is gone. Remove the objects by hand, or empty the host group. Base::noteChange() passes no host
 * group for a client it has just removed, which is indistinguishable here from a client whose
 * group this page merely cannot find, so the way to have the removal done for the operator again
 * is for the caller to say outright that the client is gone, not for this class to guess.
 *
 * The weekly report ({$EP.REPORT.WEEKLY} = 1) uses the same group: a dashboard "ElasticPro:
 * <client>" with Client resources, Client capacity and Volume report for the client's host group,
 * and a Zabbix scheduled report mailing it as PDF each Monday at 08:00 for the week before.
 * Needs Zabbix's web service (the stack runs one) and its Frontend URL set.
 *
 * The product was renamed and these names changed with it, while a production Zabbix still
 * carries the former ones on the live objects of seven clients and is not to be migrated. So
 * every lookup here answers to both namings and an object found under its former name is adopted
 * — renamed by the same update that brings it up to date. Nothing is ever written under a former
 * name. Before this, every lookup missed and a save built a second set of alerting beside the
 * live one: every problem mailed twice to a real client's DL, and two weekly PDFs.
 */
class AlertRouting {

	public const NAME_PREFIX = 'ElasticPro: ';
	private const USER_PREFIX = 'ep-dl-';
	/** Warning, Average, High, Disaster. */
	public const SEVERITIES = 60;

	/**
	 * What this page called the same things before the product was renamed. They are here to be
	 * recognised, never to be written: the production Zabbix holds seven clients' user groups, DL
	 * accounts, trigger actions, dashboards, scheduled reports and master host macros under these
	 * names, and no migration is planned, so this page has to go on answering to them for good.
	 */
	private const LEGACY_NAME_PREFIX = 'ElasticVue: ';
	private const LEGACY_USER_PREFIX = 'evp-dl-';
	private const LEGACY_MACRO_PREFIX = '{$EVP.';
	/** Its counterpart, used only to turn one into the other in canonical(). */
	private const MACRO_PREFIX = '{$EP.';

	/** The names an object of this client may carry, today's first. */
	public static function names(string $client): array {
		return [self::NAME_PREFIX.$client, self::LEGACY_NAME_PREFIX.$client];
	}

	public static function userName(string $client, bool $legacy = false): string {
		return ($legacy ? self::LEGACY_USER_PREFIX : self::USER_PREFIX)
			.substr(preg_replace('/[^A-Za-z0-9._-]+/', '-', $client), 0, 90);
	}

	/** The usernames the client's DL account may carry, today's first. */
	public static function userNames(string $client): array {
		return [self::userName($client), self::userName($client, true)];
	}

	/**
	 * The macros under today's names, each former {$EVP.…} read wherever today's name says
	 * nothing. The master hosts of the live install still carry the former macros, and a client
	 * whose macros are not understood reads as one that wants no alerts and no report — which,
	 * now that the lookups below find the live objects, would have the next save delete a working
	 * client's alert routing rather than leave it alone. Today's name wins where a host carries
	 * both, so a half-migrated host follows what was last set.
	 */
	public static function canonical(array $macros): array {
		$out = $macros;
		foreach ($macros as $macro => $value) {
			if (strncmp($macro, self::LEGACY_MACRO_PREFIX, strlen(self::LEGACY_MACRO_PREFIX)) === 0) {
				$today = self::MACRO_PREFIX.substr($macro, strlen(self::LEGACY_MACRO_PREFIX));
				$out[$today] = $out[$today] ?? $value;
			}
		}
		return $out;
	}

	/** The client's cluster DL, under either macro name. */
	public static function dl(array $macros): string {
		return trim((string) (self::canonical($macros)['{$EP.DL}'] ?? ''));
	}

	/**
	 * Whether a client, by its master host's macros, wants its problems sent to its DL. The
	 * canonical macros go to statusOf as well, so that a master host still carrying
	 * {$EVP.CLIENT.STATUS} is not read as an active client when it was decommissioned.
	 */
	public static function wanted(array $macros): bool {
		$m = self::canonical($macros);
		return ($m['{$EP.ALERT.DL}'] ?? '0') === '1' && self::dl($m) !== ''
			&& Lifecycle::statusOf($m) !== 'decommissioned';
	}

	public static function reportWanted(array $macros): bool {
		$m = self::canonical($macros);
		return ($m['{$EP.REPORT.WEEKLY}'] ?? '0') === '1' && self::dl($m) !== ''
			&& Lifecycle::statusOf($m) !== 'decommissioned';
	}

	/** The widgets of a client's report dashboard, each for the client's host group only. */
	public const REPORT_WIDGETS = [['ep_resources', 0, 6], ['ep_capacity', 6, 4], ['ep_volume', 10, 5]];
	/**
	 * The same three widgets before the rename. No module registers these types any more, so a
	 * dashboard still holding them renders nothing; they are listed so that such a dashboard is
	 * still recognised as one this page made, which is what makes it safe to delete when the
	 * report is turned off — and so the operator can be told its PDF would come out blank.
	 */
	private const LEGACY_REPORT_WIDGETS = ['evp_resources', 'evp_capacity', 'evp_volume'];

	/** Every widget type on a dashboard, over all of its pages. */
	private static function widgetTypes(array $board): array {
		$types = [];
		foreach ($board['pages'] ?? [] as $page) {
			$types = array_merge($types, array_column($page['widgets'] ?? [], 'type'));
		}
		return $types;
	}

	/** The widget types this page puts on a report dashboard, under either naming. */
	private static function ownWidgetTypes(): array {
		return array_merge(array_column(self::REPORT_WIDGETS, 0), self::LEGACY_REPORT_WIDGETS);
	}

	/**
	 * Which of the objects a both-namings lookup found is the one to work on, and what to say about
	 * it. Today's name wins; failing that the former-named one is adopted, and the update that
	 * follows renames it, which is how an existing install is taken over instead of duplicated.
	 * Anything else found is a twin — a second object a previous version of this page made under
	 * today's name beside the live former one. It is named in the notice and otherwise left alone:
	 * deleting a live trigger action, user group or report on a production Zabbix is the operator's
	 * decision to take by hand, not this page's to take for them.
	 */
	private static function find($found, string $field, string $current, string $what): array {
		// A get Zabbix refused returns false rather than a list; as before, that counts as nothing
		// found, and must not become a TypeError on the path a save calls.
		$found = is_array($found) ? $found : [];
		$keep = null;
		foreach ($found as $row) {
			if ((string) ($row[$field] ?? '') === $current) {
				$keep = $row;
				break;
			}
		}
		$said = [];
		if ($keep === null && $found) {
			$keep = reset($found);
			$said[] = _s('The %1$s "%2$s", made before the product was renamed, is the one kept and is renamed to "%3$s".',
				$what, (string) ($keep[$field] ?? ''), $current);
		}
		foreach ($found as $row) {
			if ($keep !== null && (string) ($row[$field] ?? '') !== (string) ($keep[$field] ?? '')) {
				$said[] = _s('There is a second %1$s, "%2$s", beside the one in use. Nothing here uses it, so it is left as it is: check it and delete it by hand.',
					$what, (string) ($row[$field] ?? ''));
			}
		}
		return [$keep, $said];
	}

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
	 *
	 * $legacy_settings is the caller's answer to "are this client's stored settings the ones from
	 * before the product was renamed?". true and nothing at all is done here — see unsafe() for the
	 * data loss that answer prevents. null means the caller did not say, and this class works it
	 * out from the macros it was handed, which is the weaker of the two signals: a save calls here
	 * after it has written the master host, so by then the macros may already carry today's names
	 * and only the caller still knows which generation the values came from. It is a parameter
	 * rather than a lookup because the caller is the only one holding that answer.
	 */
	public static function sync(string $client, ?string $groupid, array $macros, string $owner = '', ?bool $legacy_settings = null): array {
		// Asked and answered before a single lookup, because every lookup below leads to either an
		// update or a delete, and the deletes here cannot be undone by this module or by anyone
		// reading its backups.
		$unsafe = self::unsafe($client, $groupid, $macros, $legacy_settings);
		if ($unsafe !== null) {
			return [$unsafe];
		}
		// Read once under today's names, because what follows both keeps and deletes by it.
		$macros = self::canonical($macros);
		$name = self::NAME_PREFIX.$client;
		$done = self::syncReport($client, $groupid, $macros, $owner, false, '', $legacy_settings);
		[$group, $about_group] = self::find(API::UserGroup()->get(['output' => ['usrgrpid', 'name'],
			'filter' => ['name' => self::names($client)]]), 'name', $name, _('DL user group'));
		[$user, $about_user] = self::find(API::User()->get(['output' => ['userid', 'username'],
			'filter' => ['username' => self::userNames($client)], 'selectMedias' => ['mediaid']]),
			'username', self::userName($client), _('DL account'));
		[$action, $about_action] = self::find(API::Action()->get(['output' => ['actionid', 'name'],
			'filter' => ['name' => self::names($client)]]), 'name', $name, _('DL trigger action'));
		// Only what the macros positively say, now. The missing host group used to be folded in
		// here as `&& $groupid !== null`, which turned "this page cannot see the client's group"
		// into "this client wants no alerting" and sent the request down the removal branch below;
		// unsafe() stops that case above instead, so past this line $groupid is a real group id.
		$alerts = self::wanted($macros);
		$report = self::reportWanted($macros);
		// What was adopted or found twice is worth saying only while the objects are being kept;
		// when they are about to go, what they were called is of no help to anyone.
		if ($alerts || $report) {
			$done = array_merge($done, $about_group, $about_user, $about_action);
		}

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
		$dl = self::dl($macros);
		$p = self::plan($client, (string) $groupid, $dl, $email['mediatypeid']);

		if ($group) {
			self::api(API::UserGroup()->update(['usrgrpid' => $group['usrgrpid']] + $p['usergroup']), _('update the DL user group'));
			$gid = $group['usrgrpid'];
		}
		else {
			$gid = self::api(API::UserGroup()->create($p['usergroup']), _('create the DL user group'))['usrgrpids'][0];
		}
		if ($user) {
			// An account found under its former name is renamed by this same update, which keeps its
			// userid: the media and the group it is in are the account's, not the name's.
			$rename = $user['username'] !== self::userName($client) ? ['username' => self::userName($client)] : [];
			self::api(API::User()->update(['userid' => $user['userid'], 'usrgrps' => [['usrgrpid' => $gid]],
				'medias' => $p['media']] + $rename), _('update the DL user'));
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
			$done = array_merge($done, self::syncReport($client, $groupid, $macros, $owner, true, $gid, $legacy_settings));
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
	 * only while it holds nothing but the page's own widgets, under either naming.
	 *
	 * Both objects are looked up under today's name and the former one. What the lookups have to
	 * say about what they adopted is passed on only by the pass that keeps them: on the way out,
	 * what a report about to be deleted used to be called helps nobody.
	 */
	private static function syncReport(string $client, ?string $groupid, array $macros, string $owner, bool $make, string $gid = '', ?bool $legacy = null): array {
		// Checked here as well as in sync(), and not only because sync() gets here first: the branch
		// a few lines down deletes the scheduled report and its dashboard, and no caller of this
		// method, now or later, should be able to reach that branch on settings that may simply not
		// have been read.
		$unsafe = self::unsafe($client, $groupid, $macros, $legacy);
		if ($unsafe !== null) {
			return [$unsafe];
		}
		$name = self::NAME_PREFIX.$client;
		[$report, $about_report] = self::find(API::Report()->get(['output' => ['reportid', 'name'],
			'filter' => ['name' => array_map(fn($n) => $n.' weekly', self::names($client))]]),
			'name', $name.' weekly', _('weekly report'));
		[$board, $about_board] = self::find(API::Dashboard()->get(['output' => ['dashboardid', 'name'],
			'filter' => ['name' => self::names($client)], 'selectPages' => ['widgets']]), 'name', $name, _('report dashboard'));
		// As in sync(): what the macros say, and nothing inferred from a group this page cannot see.
		$wanted = self::reportWanted($macros);
		if (!$make) {
			if ($wanted) {
				return [];
			}
			$said = [];
			if ($report) {
				self::api(API::Report()->delete([$report['reportid']]), _('remove the weekly report'));
				$said[] = _('The weekly report is no longer sent.');
			}
			// A dashboard made before the rename holds the former widget types; counting those as
			// ours too is what lets it be cleared away, instead of staying behind for good.
			$ours = $board !== null && array_diff(self::widgetTypes($board), self::ownWidgetTypes()) === [];
			if ($ours) {
				self::api(API::Dashboard()->delete([$board['dashboardid']]), _('remove the report dashboard'));
			}
			return $said;
		}
		$p = self::reportPlan($client, (string) $groupid, $gid, $owner);
		// The widgets of an existing dashboard are left as they are, by design: an operator may have
		// arranged it. One made before the rename therefore keeps widget types no module registers
		// any more, so its PDF arrives empty — said plainly here, with the two saves that fix it,
		// because re-keying someone else's widget fields from this page would be a guess.
		$stale = $board !== null && array_intersect(self::widgetTypes($board), self::LEGACY_REPORT_WIDGETS) !== [];
		if ($board) {
			// Renamed by the same update where it was adopted. The dashboardid does not change, so
			// the scheduled report below goes on pointing at the dashboard the client already had.
			$rename = $board['name'] !== $p['dashboard']['name'] ? ['name' => $p['dashboard']['name']] : [];
			self::api(API::Dashboard()->update(['dashboardid' => $board['dashboardid'],
				'userGroups' => $p['dashboard']['userGroups']] + $rename), _('share the report dashboard'));
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
		$said = array_merge($about_report, $about_board,
			[_s('The weekly report (dashboard "%1$s") is mailed to %2$s each Monday at 08:00.', $name, self::dl($macros))]);
		if ($stale) {
			$said[] = _s('The dashboard "%1$s" still holds the report widgets of the former product name, which Zabbix no longer has, so its PDF would arrive blank. Turn the weekly report off for this client and save, then turn it on and save again: the dashboard is rebuilt with the widgets in use now.', $name);
		}
		return $said;
	}

	/**
	 * Why this sync must not run at all, or null when it may. Both answers mean one thing: the
	 * values sync() would decide from may not be this client's real ones.
	 *
	 * The failure this exists for. sync() used to fold both cases into its "not wanted" branch —
	 * `$alerts = wanted() && $groupid !== null` — so an absence of evidence became evidence of
	 * absence, and the branch it reached deletes: the trigger action with its escalation steps, the
	 * DL user group, the DL user with its Email media, the scheduled report with its delivery
	 * history and the dashboard with its layout. This module can recreate none of those. The seven
	 * clients of the pre-rebrand generation keep their settings in {$EVP.…} macros on their master
	 * host; a form that does not read those opens on shipped defaults, and the first save of
	 * anything at all — a note, a server, a role — handed those defaults to sync() and cost the
	 * client its alerting. Refusing costs one save. The branch it replaces cost the live objects of
	 * a cluster that is being monitored for real.
	 */
	private static function unsafe(string $client, ?string $groupid, array $macros, ?bool $legacy): ?string {
		if ($groupid === null) {
			// A missing host group is "cannot tell", never "wants nothing". The group is found by the
			// client's own name, so a group an operator renamed, a client whose hosts have not been
			// made yet, and a HostGroup.get that Zabbix refused all arrive here looking identical —
			// and so does a client that really has been deleted, which is why this refuses rather
			// than choosing between them. The objects of a deleted client are named in the notice so
			// they can be removed by hand, which is recoverable; deleting a live client's is not.
			return _s('Alert routing and the weekly report for "%1$s" were left exactly as they are: there is no host group named "%1$s", so this page cannot tell what alerting this client has, and it will not remove alerting it cannot see. Nothing was created, changed or deleted. Check the client\'s host group and save the client again — or, if the client really is gone, delete the user group, the DL account, the trigger action, the weekly report and the dashboard named after it by hand.', $client);
		}
		if ($legacy === true || ($legacy === null && self::cannotTrustSettings($macros))) {
			return _s('Alert routing and the weekly report for "%1$s" were left exactly as they are: its settings are still the ones from before the product was renamed, which this page reads but never writes. Nothing was created, changed or deleted — in particular, nothing was removed on the strength of settings that may simply not have been read. Open the client, check that the form shows its real settings, and save it once to bring its alerting up to date.', $client);
		}
		return null;
	}

	/**
	 * The four settings sync() and syncReport() decide from, by the part of the macro name that the
	 * rename left alone. Only these are examined below: an unrelated leftover {$EVP.…} on a master
	 * host says nothing about what this client's alerting should be, and treating one as a reason
	 * to refuse would leave that client's alerting unchangeable for as long as the macro sat there.
	 */
	private const DECIDING = ['ALERT.DL', 'DL', 'REPORT.WEEKLY', 'CLIENT.STATUS'];

	/**
	 * Whether what sync() would decide from cannot be trusted, as far as this class can tell by
	 * itself. ClientSpec is asked first because it knows the client's stored generation properly;
	 * this is the backstop for callers that pass no answer at all.
	 *
	 * Two shapes count, and both of them mean "this page does not know what the client wants":
	 *
	 *  - a setting present only as {$EVP.…}. canonical() does read it, but it is the one copy there
	 *    is and the form does not write it, so anything that saves the client writes a default
	 *    beside it and the next read prefers the default.
	 *  - a setting present under both names with different values. That is the blocker's own shape:
	 *    the form opened on shipped defaults, the save wrote {$EP.ALERT.DL} = 0 next to a live
	 *    {$EVP.ALERT.DL} = 1, and canonical() prefers today's name — so sync() would read "no
	 *    alerting wanted" off a macro written seconds earlier by a form that had never seen the
	 *    client's real answer, and delete the routing of a cluster that is alerting today.
	 *
	 * Equal values under both names are no reason to refuse: whichever one is read, the answer is
	 * the client's own. Nor is a setting that exists only under today's name, which is a client
	 * that was written since the rename and is the ordinary case.
	 */
	private static function cannotTrustSettings(array $macros): bool {
		// Either signal is enough. They can only disagree when one of them is working from less than
		// the other, and on a decision whose wrong answer is a delete, the cautious answer wins.
		if (self::toldByClientSpec($macros) === true) {
			return true;
		}
		foreach (self::DECIDING as $what) {
			$legacy = self::LEGACY_MACRO_PREFIX.$what.'}';
			$today = self::MACRO_PREFIX.$what.'}';
			if (!array_key_exists($legacy, $macros)) {
				continue;
			}
			if (!array_key_exists($today, $macros) || (string) $macros[$legacy] !== (string) $macros[$today]) {
				return true;
			}
		}
		return false;
	}

	/**
	 * ClientSpec::hasLegacyMacros() when there is such a method to call, and null when there is not
	 * or when it would not answer.
	 *
	 * It is called this carefully on purpose. The method lands in a separate change, and a hard
	 * call to a static method that does not exist raises an Error, not an Exception: it would miss
	 * the catch in Base::noteChange() that is there to turn what this class throws into a line in
	 * the notice, and the operator would get a Zabbix fatal-error page in place of a saved client.
	 * is_callable() is also false for an instance method, so if hasLegacyMacros() turns out not to
	 * be static this page falls back to its own test rather than construct a ClientSpec with roles
	 * it was never given.
	 */
	private static function toldByClientSpec(array $macros): ?bool {
		if (!is_callable([ClientSpec::class, 'hasLegacyMacros'])) {
			return null;
		}
		try {
			return (bool) ClientSpec::hasLegacyMacros($macros);
		}
		catch (\Throwable $e) {
			// A different signature than the one expected here is a reason to fall back to the test
			// above, not a reason to fail a save or to let a delete through unchecked.
			return null;
		}
	}

	private static function api($result, string $what) {
		if ($result === false) {
			$said = array_column(get_and_clear_messages(), 'message');
			throw new Exception(_s('Zabbix would not %1$s: %2$s', $what, implode(' ', $said) ?: _('no reason given')));
		}
		return $result;
	}
}
