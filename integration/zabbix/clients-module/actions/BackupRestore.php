<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use Exception;
use Modules\EpClients\Lib\{Backups, ClientSpec, Reconciler, Roles, TemplateInstaller};

/**
 * Bring every client back to a backup: roles, settings, machines. Clients added since are removed
 * (only hosts this page made); hosts deleted since are made again, without their old history.
 * The present is backed up first, so a restore can itself be undone. A client that is just as it
 * was in the backup is left alone: a restore changes only what changed since.
 */
class BackupRestore extends Base {

	protected function checkInput(): bool {
		return $this->validateInput(['id' => 'required|string']);
	}

	protected function doAction(): void {
		$b = Backups::get((string) $this->getInput('id'));
		if (!$b) {
			$this->toList(_('Backup not found'), [], true);
			return;
		}
		$lines = [];
		try {
			$present = Backups::get($this->backup('Restore '.$b['id']));
			$now_clients = array_keys($present['clients'] ?? $this->state()->clients());
			$same_roles = Roles::hash($b['roles']) === Roles::hash($this->roles());
			if (!$same_roles) {
				Roles::save($b['roles']);
				TemplateInstaller::install($b['roles']);
				$lines[] = _('Roles restored and the master template rewritten for them.');
			}
			$spec = new ClientSpec($b['roles']);
			foreach ($b['clients'] as $name => $form) {
				if ($same_roles && isset($present['clients'][$name]) && Backups::sameForm($present['clients'][$name], $form)) {
					$lines[] = _s('%1$s is as it was — left alone.', $name);
					continue;
				}
				$rec = new Reconciler($spec);
				['client' => $client, 'errors' => $errors] = $spec->fromForm($form);
				if ($errors) {
					$lines[] = _s('%1$s skipped: %2$s', $name, implode(' ', $errors));
					continue;
				}
				$rec->apply($client);
				$this->noteChange($name, 'restored');
				$lines[] = _s('%1$s restored. %2$s', $name, implode(' ', $rec->done()));
			}
			foreach (array_diff($now_clients, array_keys($b['clients'])) as $name) {
				$rec = new Reconciler($spec);
				$rec->remove($name);
				$this->noteChange($name, 'removed by restore');
				$lines[] = _s('%1$s was added after the backup and is removed. %2$s', $name, implode(' ', $rec->done()));
			}
			$this->toList(_s('Restored the backup of %1$s', date('d M H:i', (int) $b['taken'])), $lines);
		}
		catch (Exception $e) {
			$this->toList(_('Restore stopped'), $lines, true, $e->getMessage());
		}
	}
}
