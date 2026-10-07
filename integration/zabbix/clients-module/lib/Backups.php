<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

/**
 * A copy of every client and of the roles, taken before any change — an import, a save, a
 * removal, a role change, a restore. The newest three are kept.
 *
 * A backup holds what the Clients page manages: each client's form (settings, requested
 * figures, servers) and the roles configuration. A backup from an older version (machines per
 * role, schema 1) is read in today's terms, so it still restores. Restoring brings those back; it
 * cannot bring back the history of a host deleted since, and says so where it is offered.
 *
 * Only three are kept, so a backup that holds nothing is not a harmless one: three of them push
 * every real copy out. take() therefore refuses an empty client list while backups that hold
 * clients are still here — see it for why.
 */
class Backups {

	public const KEEP = 3;
	public const DIR = 'backups';
	public const SCHEMA = 2;

	/**
	 * The code take() refuses an empty client list with. A caller checks for it instead of
	 * catching every RuntimeException, because the other reasons take() throws — the data folder
	 * missing or not writable — must not be retried: retrying those writes nothing either way,
	 * and a caller that treated them as "the list was empty" would report a backup it never got.
	 * BackupRestore is the one caller that needs the difference; see $allow_empty below.
	 */
	public const REFUSED_EMPTY = 1001;

	/**
	 * A copy of everything, taken before a change, and the oldest beyond KEEP pruned.
	 *
	 * It refuses outright when the client list is empty while the backups already here hold
	 * clients. An empty list is far likelier to be a lookup that found nothing than a site whose
	 * clients have all gone: the clients are found by a template name and a host tag, both of which
	 * changed when the product was renamed, and a production Zabbix still carries the former ones.
	 * Recording it would write a backup of nothing and prune the newest real one away, and three
	 * such saves — KEEP is 3 — would leave no copy of any client at all. Refusing instead stops
	 * the change that asked for the backup, which is the right way round: nothing should be changed
	 * while the page cannot see what it is about to change. A site that has never had a client in a
	 * backup is let through, so the first client of a fresh install can still be added.
	 *
	 * $allow_empty is for one caller, the restore. Restoring a backup onto an install that
	 * currently reads zero clients is exactly the case where the snapshot of the present is worth
	 * most — it is the only way back from a restore that turns out to have been the wrong one —
	 * and the refusal above was stopping the restore before that snapshot was taken, leaving the
	 * operator with no copy of the present at all. With $allow_empty the snapshot is written even
	 * though it holds nothing, and the pruning below is what keeps it from costing anything: a
	 * snapshot of no clients never deletes a copy that holds clients. Ordinary saves pass
	 * $allow_empty false and are refused exactly as before — nothing about this weakens them.
	 */
	public static function take(string $before, string $by, ClientState $state, array $roles, bool $allow_empty = false): string {
		$clients = [];
		foreach ($state->clients() as $name => $_) {
			$clients[$name] = ClientState::plain($state->formFor($name));
		}
		if (!$clients && !$allow_empty && self::holdsClients()) {
			throw new \RuntimeException(_('No clients were found, but the backups already taken hold some. Nothing has been changed and no backup was taken: a backup of nothing would push the copies that still have those clients in them out. Open Cluster Management and check that it lists its clients before changing anything.'), self::REFUSED_EMPTY);
		}
		$hosts = 0;
		foreach ($clients as $form) {
			$hosts += count((array) json_decode((string) ($form['servers'] ?? '[]'), true));
		}
		$id = gmdate('Ymd-His').'-'.bin2hex(random_bytes(2));
		Store::write(self::DIR.'/'.$id.'.json', [
			'id' => $id,
			'schema' => self::SCHEMA,
			'taken' => time(),
			'by' => $by,
			'before' => $before,
			'roles' => $roles,
			'clients' => $clients,
			'machines' => $hosts
		]);
		// Only KEEP are kept, and the oldest beyond that go — except that a snapshot holding no
		// clients never pushes out a copy that holds some. Without this, the one snapshot taken
		// under $allow_empty would delete the oldest copy that still has the seven live clients in
		// it, which is the copy the operator needs if the restore it was taken for goes wrong. The
		// same holds for a fresh install's empty snapshots, which holdsClients() lets through.
		foreach (array_slice(Store::listing(self::DIR), self::KEEP) as $old) {
			if (!$clients) {
				$older = Store::read($old);
				if ($older !== null && (array) ($older['clients'] ?? []) !== []) {
					continue;
				}
			}
			Store::delete($old);
		}
		return $id;
	}

	/** Whether any backup still kept holds a client at all — the signal take() refuses on. */
	private static function holdsClients(): bool {
		foreach (self::list() as $b) {
			if ($b['clients'] > 0) {
				return true;
			}
		}
		return false;
	}

	/** Two saved client forms mean the same client: every field alike, ignoring order and "_" keys. */
	public static function sameForm(array $a, array $b): bool {
		$norm = function (array $f): array {
			$out = [];
			foreach ($f as $k => $v) {
				if (is_string($k) && $k !== '' && $k[0] !== '_' && !is_array($v)) {
					$out[$k] = trim((string) $v);
				}
			}
			ksort($out);
			return array_filter($out, fn($v) => $v !== '');
		};
		return $norm($a) === $norm($b);
	}

	/** Newest first, without the client forms. */
	public static function list(): array {
		$out = [];
		foreach (Store::listing(self::DIR) as $file) {
			$b = Store::read($file);
			if ($b) {
				$out[] = ['id' => $b['id'], 'taken' => $b['taken'], 'by' => $b['by'], 'before' => $b['before'],
					'clients' => count($b['clients']), 'machines' => $b['machines'] ?? 0];
			}
		}
		return $out;
	}

	/** A backup, its roles and forms in today's terms. */
	public static function get(string $id): ?array {
		if (!preg_match('/^\d{8}-\d{6}-[0-9a-f]{4}$/', $id)) {
			return null;
		}
		$b = Store::read(self::DIR.'/'.$id.'.json');
		if (!$b) {
			return null;
		}
		$b['roles'] = Roles::upgrade($b['roles']);
		if ((int) ($b['schema'] ?? 1) < self::SCHEMA) {
			$spec = new ClientSpec($b['roles']);
			foreach ($b['clients'] as $name => $form) {
				$b['clients'][$name] = $spec->upgradeForm($form);
			}
			$b['schema'] = self::SCHEMA;
		}
		return $b;
	}
}
