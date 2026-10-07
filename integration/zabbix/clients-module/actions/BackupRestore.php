<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use Exception;
use Modules\EpClients\Lib\{Backups, ClientSpec, ClientState, Reconciler, Roles, TemplateInstaller};

/**
 * Bring every client back to a backup: roles, settings, machines. Hosts deleted since are made
 * again, without their old history. The present is backed up first, so a restore can itself be
 * undone. A client that is just as it was in the backup is left alone: a restore changes only
 * what changed since.
 *
 * It deletes nothing that was not confirmed. A restore has two destructive sides — hosts this
 * page made that the backup does not list, and the items of a role the backup does not have —
 * and a deleted Zabbix host or item takes its history with it, which no backup here can bring
 * back. The page that reaches this action offers one blanket confirm dialog, which does not name
 * what would go, and until the rename this action never saw the seven live clients at all; now
 * that Reconciler::isManaged() recognises the old marker too, those forty-odd hosts are in its
 * delete set for the first time. So this action works the whole delete set out first, while it
 * has changed nothing, and without a confirmation naming exactly that set it leaves every one of
 * them alone and reports what it refused to do.
 *
 * The confirmation is the `confirm_delete` signature, the same mechanism ClientSave uses: a
 * restore goes ahead with its deletions only for the host and role list it was shown. The
 * backups view (views/ep.clients.backups.php) does not show that list or send the signature yet,
 * so today every restore that would delete takes the refusing path and the operator deletes by
 * hand in Data collection → Hosts what is really meant to go. That is the intended way round:
 * the hosts stay until a person says otherwise.
 */
class BackupRestore extends Base {

	protected function checkInput(): bool {
		return $this->validateInput(['id' => 'required|string', 'confirm_delete' => 'string']);
	}

	protected function doAction(): void {
		$b = Backups::get((string) $this->getInput('id'));
		if (!$b) {
			$this->toList(_('Backup not found'), [], true);
			return;
		}
		$lines = [];
		try {
			/* ----------------------------- first pass: reading only -----------------------------
			 *
			 * Nothing below this point changes anything in Zabbix. The whole delete set is worked
			 * out while that is still true, because a restore cannot be called back half way: once
			 * Reconciler::apply() has deleted a host, the host's item history is gone whatever the
			 * rest of the request decides.
			 *
			 * current() is read with the backup's roles, not the live ones, because that is what
			 * the second pass applies with — reading it with the live roles would work out the
			 * delete set of a restore nobody asked for.
			 */
			$spec = new ClientSpec($b['roles']);
			$state = $this->state();
			$live = $state->clients();
			$same_roles = Roles::hash($b['roles']) === Roles::hash($this->roles());
			$unchanged = [];
			$deletes_of = [];
			$deletes = [];
			foreach ($b['clients'] as $name => $form) {
				if ($same_roles && isset($live[$name]) && Backups::sameForm(ClientState::plain($state->formFor($name)), $form)) {
					$unchanged[$name] = true;
					continue;
				}
				['client' => $client, 'errors' => $errors] = $spec->fromForm($form);
				if ($errors) {
					// The second pass reports the mistakes and changes nothing for this client.
					continue;
				}
				$rec = new Reconciler($spec);
				$deletes_of[$name] = self::deletesFor($rec, $client, $rec->current($name));
				$deletes += $deletes_of[$name];
			}
			// Clients added since the backup: a restore removes them, which means every host this
			// page made for them. That is the largest delete set of the three and the one the live
			// install is most exposed to, because a client the page could not see before the rename
			// is not in any backup taken before it, so it reads as "added since".
			$removes_of = [];
			foreach (array_diff(array_keys($live), array_keys($b['clients'])) as $name) {
				$removes_of[$name] = self::managedHostsOf((new Reconciler($spec))->current($name));
				$deletes += $removes_of[$name];
			}
			// A role the backup does not have loses its items, triggers and graphs from the master
			// template, and their history on every master host linked to it, because
			// TemplateInstaller::RULES carry deleteMissing. That cannot be undone either, and it
			// cannot be done piecemeal: the clients are applied with the backup's roles, so the
			// template must either be rewritten for them or the restore must not run at all.
			$lost_roles = $same_roles ? [] : self::rolesLost($this->roles(), $b['roles']);
			ksort($deletes);
			$sig = sha1(implode(',', array_merge(array_keys($deletes), array_keys($lost_roles))));
			$confirmed = ($deletes || $lost_roles) && hash_equals($sig, (string) $this->getInput('confirm_delete', ''));

			if ($lost_roles && !$confirmed) {
				foreach ($lost_roles as $label) {
					$lines[] = _s('The role "%1$s" is not in this backup. Restoring it would delete that role\'s items, triggers and graphs from the master template, and their history on every client master host.', $label);
				}
				$lines = array_merge($lines, self::wouldDeleteLines($deletes));
				$lines[] = _('Nothing has been changed. Remove the roles you no longer want from the Roles page, which says what that costs, and restore again.');
				$this->toList(_s('Restore of %1$s refused: it would delete history that cannot be brought back',
					date('d M H:i', (int) $b['taken'])), $lines, true);
				return;
			}

			/* ----------------------------- second pass: the restore ----------------------------- */

			// The snapshot of the present, so this restore can itself be undone. Backups::take()
			// refuses an empty client list for ordinary saves, and rightly: an empty backup prunes
			// the real ones away. A restore is the one case where the snapshot is worth more than
			// that refusal — an install that reads no clients is exactly where the operator needs
			// a way back — so the refusal, and only that refusal, is taken as permission to record
			// the empty snapshot instead. Any other failure of take() (the data folder missing or
			// not writable) still stops the restore, because then nothing can be recorded at all.
			try {
				$this->backup('Restore '.$b['id']);
			}
			catch (Exception $e) {
				if ($e->getCode() !== Backups::REFUSED_EMPTY) {
					throw $e;
				}
				$taken = Backups::take('Restore '.$b['id'].' — no clients could be read', $this->user(), $state, $this->roles(), true);
				// Base::backup() is what records the backup id against this change in the history,
				// and it is the only thing that can; this path therefore leaves the history entry
				// without one, so the id is named here instead.
				$lines[] = _s('No clients could be read, so the snapshot taken before this restore (%1$s) holds none. It still records the roles. No copy that holds clients was pruned to make room for it.', $taken);
			}

			if (!$same_roles) {
				Roles::save($b['roles']);
				TemplateInstaller::install($b['roles']);
				$lines[] = _('Roles restored and the master template rewritten for them.');
			}
			foreach ($b['clients'] as $name => $form) {
				if (isset($unchanged[$name])) {
					$lines[] = _s('%1$s is as it was — left alone.', $name);
					continue;
				}
				['client' => $client, 'errors' => $errors] = $spec->fromForm($form);
				if ($errors) {
					$lines[] = _s('%1$s skipped: %2$s', $name, implode(' ', $errors));
					continue;
				}
				if (!$confirmed && ($deletes_of[$name] ?? [])) {
					$lines[] = _s('%1$s was NOT restored: restoring it would delete %2$s, and the item history on them with them. Nothing about %1$s has been changed. Delete by hand in Data collection → Hosts whatever is really meant to go, then restore again.',
						$name, self::hostList($deletes_of[$name]));
					continue;
				}
				$rec = new Reconciler($spec);
				$rec->apply($client);
				$this->noteChange($name, 'restored');
				$lines[] = _s('%1$s restored. %2$s', $name, implode(' ', $rec->done()));
			}
			foreach ($removes_of as $name => $hosts) {
				// An empty $hosts means every host of that client was made by hand: remove() keeps
				// those and so deletes nothing, and there is nothing here to refuse.
				if (!$confirmed && $hosts) {
					$lines[] = _s('%1$s was added after the backup and is NOT removed: removing it would delete %2$s, and their history with them. Remove it from the clients list, which names the hosts first, if that is really meant.',
						$name, self::hostList($hosts));
					continue;
				}
				$rec = new Reconciler($spec);
				$rec->remove($name);
				$this->noteChange($name, 'removed by restore');
				$lines[] = _s('%1$s was added after the backup and is removed. %2$s', $name, implode(' ', $rec->done()));
			}
			$refused = !$confirmed && ($deletes || $lost_roles);
			$this->toList($refused
				? _s('Restored the backup of %1$s, except what would have deleted history', date('d M H:i', (int) $b['taken']))
				: _s('Restored the backup of %1$s', date('d M H:i', (int) $b['taken'])), $lines, $refused);
		}
		catch (Exception $e) {
			$this->toList(_('Restore stopped'), $lines, true, $e->getMessage());
		}
	}

	/**
	 * The hosts restoring this client would delete, hostid => name.
	 *
	 * Reconciler::plannedDeletes() is the list the edit form shows, and it is the right starting
	 * point, but it leaves out one host Reconciler::servers() does delete: one this page made,
	 * holding a role, whose agent interface carries no IP. plannedDeletes() skips those because it
	 * matches servers by IP, and servers() has no IP to keep it by either, so it falls into the
	 * "no longer listed" set and goes. A preview that misses a host is far worse than one that
	 * names a host which turns out to survive, so it is counted here.
	 */
	private static function deletesFor(Reconciler $rec, array $client, array $now): array {
		$out = $rec->plannedDeletes($client, $now);
		foreach ($now['machines'] as $h) {
			if ($h['_ip'] === null && $h['_roles'] && Reconciler::isManaged($h)) {
				$out[$h['hostid']] = $h['name'];
			}
		}
		return $out;
	}

	/**
	 * Every host Reconciler::remove() would delete for a client, hostid => name: the ones this
	 * page made, recognised under the current marker or the pre-rename one. Hosts made by hand it
	 * keeps, so they are not counted.
	 */
	private static function managedHostsOf(array $now): array {
		$out = [];
		foreach (array_merge(array_filter([$now['master'], $now['cluster'], $now['ulm']]), array_values($now['machines'])) as $h) {
			if (Reconciler::isManaged($h)) {
				$out[$h['hostid']] = $h['name'];
			}
		}
		return $out;
	}

	/** Roles the live configuration has that the backup does not, id => label. */
	private static function rolesLost(array $now, array $backup): array {
		$kept = array_column(Roles::allRoles($backup), 'id');
		$out = [];
		foreach (Roles::allRoles($now) as $r) {
			if (!in_array($r['id'], $kept, true)) {
				$out[$r['id']] = (string) ($r['label'] ?? $r['id']);
			}
		}
		ksort($out);
		return $out;
	}

	/** "host-a", "host-b" — named one by one, because a count tells an operator nothing. */
	private static function hostList(array $hosts): string {
		return implode(', ', array_map(fn($n) => '"'.$n.'"', array_values($hosts)));
	}

	/** One line per host, with its id, so the operator can find it in Data collection → Hosts. */
	private static function wouldDeleteLines(array $hosts): array {
		$out = [];
		foreach ($hosts as $hostid => $name) {
			$out[] = _s('Would delete the host "%1$s" (host id %2$s) and every item history on it.', $name, (string) $hostid);
		}
		return $out;
	}
}
