<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

use API;

/**
 * What this Zabbix actually has under each mapped template name, for the mapping table on the
 * Roles page.
 *
 * The mapping exists because a template may be called something this module does not expect — a
 * site's own name, or the name an older release shipped. Typing a name is only half of that: a
 * name typed with a space out of place looks exactly like a correct one on the page and then
 * quietly finds nothing, which is the failure the mapping was meant to end. So every mapped name
 * is looked up here and the page says what was found, how many hosts carry it, and whether the
 * template is one this module wrote.
 *
 * Nothing here writes. It reads templates and counts their hosts.
 */
class TemplateMap {

	/**
	 * Slot => the seed its template's root uuid is written from, for the slots install() writes.
	 *
	 * One definition of slot-to-identity. Every uuid this module writes comes from
	 * MasterTemplate::uuid($seed), and the same seed through MasterTemplate::legacyUuid() gives
	 * the uuid the pre-rename release wrote — which is why a template can be recognised as ours
	 * across the rename rather than only by its name.
	 */
	private const SEEDS = [
		'master' => 'template',
		'cluster' => 'cluster/template',
		'devices' => 'devices/template',
		'jump' => 'jump/template',
		'jump_ulm' => 'jump/ulm/template'
	];

	/** How many template names the picker offers before it says it has stopped listing them. */
	public const PICK_LIMIT = 400;

	/** The uuids this module would write for a slot, current first; empty for one it never writes. */
	public static function ourUuids(string $slot): array {
		$seed = self::SEEDS[$slot] ?? null;
		return $seed === null ? [] : [MasterTemplate::uuid($seed), MasterTemplate::legacyUuid($seed)];
	}

	/**
	 * One row per slot: the name in force, where it came from, and what Zabbix has under it.
	 *
	 * 'problem' is the sentence the page shows, empty when there is nothing to say. It is
	 * deliberately not raised for a template this module writes and Zabbix does not have yet:
	 * that is the normal state before the templates are installed, and calling it a problem
	 * would train an operator to ignore the column.
	 */
	public static function rows(): array {
		$names = Roles::templateNames();
		$aliases = Roles::templateAliases();

		$want = [];
		foreach ($names as $slot => $name) {
			$want[] = $name;
			foreach ($aliases[$slot] ?? [] as $a) {
				$want[] = $a;
			}
		}
		$have = self::lookup(array_values(array_unique($want)));

		$rows = [];
		foreach (Roles::TEMPLATE_SLOTS as $slot => [$shipped, $writes]) {
			$name = $names[$slot] ?? $shipped;
			$t = $have[$name] ?? null;
			$ours = $t === null ? null : in_array($t['uuid'], self::ourUuids($slot), true);
			$rows[$slot] = [
				'slot' => $slot,
				'name' => $name,
				'shipped' => $shipped,
				'mapped' => $name !== $shipped,
				'writes' => $writes,
				'found' => $t !== null,
				'hosts' => $t['hosts'] ?? 0,
				'ours' => $ours,
				'problem' => self::problem($writes, $name, $t, $ours),
				'aliases' => self::aliasRows($aliases[$slot] ?? [], $name, $have)
			];
		}
		return $rows;
	}

	/** The sentence for one row, or '' when the row is fine. */
	private static function problem(bool $writes, string $name, ?array $t, ?bool $ours): string {
		if ($writes && $t !== null && $ours === false) {
			return _s('A template called "%1$s" already exists and is not one this page wrote. Installing would fail: Zabbix matches a template by its uuid and refuses to import one whose name belongs to another object. Map this to a different name, or rename that template first.', $name);
		}
		if (!$writes && $t === null) {
			return _s('No template on this Zabbix is called "%1$s", so nothing will be found under this name. Pick an existing name, or add the name this Zabbix really uses.', $name);
		}
		if ($writes && $t === null) {
			return '';
		}
		return '';
	}

	/** One entry per extra name: whether Zabbix has it and how many hosts carry it. */
	private static function aliasRows(array $aliases, string $name, array $have): array {
		$out = [];
		foreach ($aliases as $a) {
			if ($a === $name) {
				continue;
			}
			$out[] = ['name' => $a, 'found' => isset($have[$a]), 'hosts' => $have[$a]['hosts'] ?? 0];
		}
		return $out;
	}

	/**
	 * The picker's view of a stored list of template names: those Zabbix has, as {id, name} for
	 * the multiselect, and those it has not, which the picker cannot hold at all.
	 *
	 * The second list is the point. A multiselect works in template ids, so a name this Zabbix
	 * no longer has can go into it and come back out of it — opening a role and pressing Save
	 * would drop that name without a word. The form keeps those names in a hidden field and
	 * shows them beside the picker, so a template renamed or deleted outside this page survives
	 * a save it had nothing to do with.
	 */
	public static function pick(array $names): array {
		$names = array_values(array_unique(array_filter(array_map('trim', $names), fn($n) => $n !== '')));
		$have = self::lookup($names);
		$known = [];
		$missing = [];
		foreach ($names as $n) {
			if (isset($have[$n])) {
				$known[] = ['id' => $have[$n]['templateid'], 'name' => $n];
			}
			else {
				$missing[] = $n;
			}
		}
		return ['known' => $known, 'missing' => $missing];
	}

	/** The names of the templates these ids belong to, in Zabbix's order; unknown ids are dropped. */
	public static function namesOf(array $ids): array {
		$ids = array_values(array_filter(array_map('strval', $ids), fn($i) => $i !== '' && ctype_digit($i)));
		if (!$ids) {
			return [];
		}
		return array_column(API::Template()->get(['output' => ['host'], 'templateids' => $ids, 'sortfield' => 'host']) ?: [], 'host');
	}

	/** name => {uuid, hosts} for the names asked about; a name Zabbix has not got is absent. */
	private static function lookup(array $names): array {
		if (!$names) {
			return [];
		}
		$out = [];
		foreach (API::Template()->get(['output' => ['templateid', 'host', 'uuid'], 'filter' => ['host' => $names],
				'selectHosts' => ['hostid']]) ?: [] as $t) {
			$out[$t['host']] = ['uuid' => (string) ($t['uuid'] ?? ''), 'hosts' => count($t['hosts'] ?? []),
				'templateid' => $t['templateid']];
		}
		return $out;
	}

	/**
	 * Template names to offer in the picker, sorted, and whether the list is all of them.
	 *
	 * A Zabbix with more templates than PICK_LIMIT is not listed in full, and says so rather
	 * than showing a short list that looks complete — an operator who cannot find their template
	 * in the picker would otherwise conclude it does not exist.
	 */
	public static function choices(): array {
		$all = API::Template()->get(['output' => ['host'], 'sortfield' => 'host', 'limit' => self::PICK_LIMIT + 1]) ?: [];
		$names = array_column($all, 'host');
		return ['names' => array_slice($names, 0, self::PICK_LIMIT), 'complete' => count($names) <= self::PICK_LIMIT];
	}
}
