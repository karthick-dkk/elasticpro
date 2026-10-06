<?php declare(strict_types = 0);

namespace Modules\EpResources\Lib;

/**
 * A report's column settings: names changed, columns hidden, order moved — one setting for
 * everyone, changed by Super admins.
 *
 * Kept per report in the data folder (columns-<report>.json) as
 *   { "labels": {id: "name"}, "hidden": [id, …], "order": [id, …], "split": [familyId, …] }
 * A column the report has that the settings do not mention keeps its place and name, so a new
 * role appears in the report without anyone touching its settings.
 *
 * Copied from ../../shared/php by ../../sync-assets.mjs — edit it there.
 */
class ColumnSettings {

	public static function file(string $report): string {
		return 'columns-'.preg_replace('/[^a-z0-9_-]/', '', $report).'.json';
	}

	public static function load(string $report): array {
		$s = Store::read(self::file($report), []);
		return [
			'labels' => is_array($s['labels'] ?? null) ? $s['labels'] : [],
			'hidden' => array_values(array_filter((array) ($s['hidden'] ?? []), 'is_string')),
			'order' => array_values(array_filter((array) ($s['order'] ?? []), 'is_string')),
			'split' => array_values(array_filter((array) ($s['split'] ?? []), 'is_string'))
		];
	}

	/**
	 * Settings as they came from the dialog, cleaned, then saved. With `$known_ids`, ids the
	 * report does not have are dropped; without, any id shaped like a column id is kept.
	 */
	public static function save(string $report, array $in, ?array $known_ids): array {
		$ok = fn($id) => is_string($id) && ($known_ids === null ? preg_match('/^[a-z0-9_.:\[\]\-]{1,120}$/i', $id) === 1 : in_array($id, $known_ids, true));
		$known = [];
		foreach (array_merge(array_keys((array) ($in['labels'] ?? [])), (array) ($in['hidden'] ?? []), (array) ($in['order'] ?? [])) as $id) {
			if ($ok($id)) {
				$known[$id] = true;
			}
		}
		$labels = [];
		foreach ((array) ($in['labels'] ?? []) as $id => $label) {
			$label = trim((string) $label);
			if (isset($known[$id]) && $label !== '') {
				$labels[$id] = mb_substr($label, 0, 80);
			}
		}
		$clean = [
			'labels' => $labels,
			'hidden' => array_values(array_filter((array) ($in['hidden'] ?? []), fn($id) => isset($known[$id]))),
			'order' => array_values(array_unique(array_filter((array) ($in['order'] ?? []), fn($id) => isset($known[$id])))),
			'split' => array_values(array_filter((array) ($in['split'] ?? []), fn($id) => is_string($id) && preg_match('/^[a-z][a-z0-9_]*$/', $id)))
		];
		Store::write(self::file($report), $clean);
		return $clean;
	}

	public static function reset(string $report): void {
		Store::delete(self::file($report));
	}

	/**
	 * The report's columns with the settings applied: in order, renamed, hidden ones gone.
	 * Each column needs an `id` and a `label`; its own label is kept as `default`.
	 */
	public static function apply(array $columns, array $settings, bool $keep_hidden = false): array {
		$byId = [];
		foreach ($columns as $i => $c) {
			$c['default'] = $c['label'];
			if (isset($settings['labels'][$c['id']])) {
				$c['label'] = $settings['labels'][$c['id']];
			}
			$c['hidden'] = in_array($c['id'], $settings['hidden'], true);
			$c['_pos'] = $i;
			$byId[$c['id']] = $c;
		}
		// Saved order first. A column the settings never saw — a role added later — goes right
		// after the column it followed in the report, so it lands beside its own section.
		$seq = [];
		foreach ($settings['order'] as $id) {
			if (isset($byId[$id]) && !in_array($id, $seq, true)) {
				$seq[] = $id;
			}
		}
		$original = array_keys($byId);
		foreach ($original as $i => $id) {
			if (in_array($id, $seq, true)) {
				continue;
			}
			$at = 0;
			for ($j = $i - 1; $j >= 0; $j--) {
				$k = array_search($original[$j], $seq, true);
				if ($k !== false) {
					$at = $k + 1;
					break;
				}
			}
			array_splice($seq, $at, 0, [$id]);
		}
		$ordered = [];
		foreach ($seq as $id) {
			$ordered[$id] = $byId[$id];
		}
		$byId = $ordered;
		$out = [];
		foreach ($byId as $c) {
			unset($c['_pos']);
			if ($keep_hidden || !$c['hidden']) {
				$out[] = $c;
			}
		}
		return $out;
	}
}
