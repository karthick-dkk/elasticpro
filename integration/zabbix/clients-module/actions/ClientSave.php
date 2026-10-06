<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use Exception;

/**
 * Add or edit a client. A form with mistakes comes back with them and nothing saved; a backup is
 * taken before anything changes; after saving, the client is read back and compared. A save that
 * would delete hosts comes back listing them, and goes ahead only once that is confirmed. A password
 * typed for a Zabbix secret goes to Zabbix only — never into the form, a backup or a log.
 */
class ClientSave extends Base {

	protected function checkInput(): bool {
		$fields = ['name' => 'required|string', 'mode' => 'required|in add,edit', 'es_password' => 'string', 'merge' => 'array', 'confirm_delete' => 'string'];
		foreach (array_keys($this->spec()->defaults()) as $field) {
			$fields[$field] = $fields[$field] ?? 'string';
		}
		return $this->validateInput($fields);
	}

	protected function doAction(): void {
		$spec = $this->spec();
		$input = [];
		foreach (array_keys($spec->defaults()) as $field) {
			$input[$field] = (string) $this->getInput($field, '');
		}
		$mode = $this->getInput('mode');
		$secret = ['es_password' => (string) $this->getInput('es_password', ''),
			'merge' => implode(',', array_map('strval', (array) $this->getInput('merge', [])))];
		['client' => $client, 'errors' => $errors] = $spec->fromForm($input + $secret);
		$rec = $this->rec();
		$now = null;
		if (!$errors) {
			$now = $rec->current($client['name']);
			if ($mode === 'add' && $now['master'] !== null) {
				$errors[] = _s('Client "%1$s" exists already — edit it from the list.', $client['name']);
			}
			else {
				$errors = $rec->problems($client, $now);
			}
		}
		$deletes = [];
		if (!$errors && $now !== null) {
			$deletes = $rec->plannedDeletes($client, $now);
			// Confirmed for exactly these hosts: a list that changed since asks again.
			$sig = sha1(implode(',', array_keys($deletes)));
			if ($deletes && (string) $this->getInput('confirm_delete', '') !== $sig) {
				$current = $this->state()->formFor($client['name']);
				$input['_now'] = $current['_now'] ?? null;
				$input['_shared'] = $current['_shared'] ?? [];
				$input['_unassigned'] = $current['_unassigned'] ?? [];
				$input['_deletes'] = ['hosts' => array_values($deletes), 'sig' => $sig];
				$input['_current_servers'] = $current['servers'] ?? '[]';
				$input['merge'] = $secret['merge'];
				$this->setResponse(ClientEdit::page($this, $input, $mode, [], false, []));
				return;
			}
		}
		if (!$errors) {
			try {
				$this->backup(($mode === 'add' ? 'Add ' : 'Edit ').$client['name']);
				$rec->apply($client);
				$this->noteChange($client['name'], $mode === 'add' ? 'added' : 'edited');
				$problems = $this->importer()->verify($client);
				$this->toList($mode === 'add' ? _s('Client "%1$s" added', $client['name']) : _s('Client "%1$s" saved', $client['name']),
					array_merge($rec->done(), $problems ? [_('Read back from Zabbix, these differ: ').implode(' ', $problems)] : [_('Read back from Zabbix: everything matches.')]));
				return;
			}
			catch (Exception $e) {
				$errors[] = $e->getMessage();
			}
		}
		$current = $input['name'] !== '' ? $this->state()->formFor($input['name']) : [];
		$input['_now'] = $current['_now'] ?? null;
		$input['_shared'] = $current['_shared'] ?? [];
		$input['_unassigned'] = $current['_unassigned'] ?? [];
		$input['_current_servers'] = $current['servers'] ?? '[]';
		$this->setResponse(ClientEdit::page($this, $input, $mode, $errors, false, $rec->done()));
	}
}
