<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use Exception;
use Modules\EpClients\Lib\Store;

/** Apply the ticked changes of an import, after a backup of how things are now. */
class ImportApply extends Base {

	protected function checkInput(): bool {
		return $this->validateInput(['token' => 'required|string', 'apply' => 'array']);
	}

	protected function doAction(): void {
		$pending = Store::read('pending-import.json');
		if (!$pending || !hash_equals((string) $pending['token'], (string) $this->getInput('token'))) {
			$this->toList(_('Nothing to apply'), [], true, _('This import is no longer pending — it was applied, cancelled, or another import replaced it.'));
			return;
		}
		Store::delete('pending-import.json');
		$chosen = array_filter((array) $this->getInput('apply', []), fn($v) => (string) $v === '1');
		$spec = $this->spec();
		$lines = [];
		if (array_intersect_key($chosen, array_flip(array_column($pending['rows'], 'name')))) {
			try {
				$this->backup('Import '.($pending['file'] ?? '').' — confirmed changes');
			}
			catch (Exception $e) {
				$this->toList(_('Nothing applied'), [], true, $e->getMessage());
				return;
			}
		}
		$failed = false;
		foreach ($pending['rows'] as $row) {
			if (!isset($chosen[$row['name']])) {
				$lines[] = _s('%1$s left as it was.', $row['name']);
				continue;
			}
			$rec = $this->rec();
			['client' => $client] = $spec->fromForm($row['form']);
			try {
				$rec->apply($client);
				$this->noteChange($client['name'], 'imported');
				$problems = $this->importer()->verify($client);
				$lines[] = _s('%1$s: %2$s', $client['name'], implode(' ', $rec->done()) ?: _('saved.'));
				$lines[] = $problems ? _s('%1$s read back — differs: %2$s', $client['name'], implode(' ', $problems))
					: _s('%1$s read back — matches the file.', $client['name']);
			}
			catch (Exception $e) {
				$failed = true;
				$lines[] = _s('%1$s: %2$s', $client['name'], $e->getMessage());
			}
		}
		$this->toList($failed ? _('Import applied, with problems') : _('Import applied'), $lines, $failed);
	}
}
