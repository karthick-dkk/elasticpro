<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use Exception;

/**
 * Delete a decommissioned client for good: the hosts this page made for it, with their history,
 * after a backup. Only a decommissioned client, and only when its name is typed to confirm. Hosts
 * made by hand and the host group stay.
 */
class ClientRemove extends Base {

	protected function checkInput(): bool {
		return $this->validateInput(['client' => 'required|string', 'confirm' => 'string']);
	}

	protected function doAction(): void {
		$client = trim((string) $this->getInput('client'));
		$rec = $this->rec();
		try {
			if ($this->lifecycle()->status($client) !== 'decommissioned') {
				throw new Exception(_('Only a decommissioned client can be deleted for good: disable it, then decommission it.'));
			}
			if (trim((string) $this->getInput('confirm', '')) !== $client) {
				throw new Exception(_s('Type the client\'s name, %1$s, to delete it for good.', $client));
			}
			$this->backup('Delete '.$client);
			$rec->remove($client);
			$this->noteChange($client, 'deleted for good');
			$this->toList(_s('Client "%1$s" deleted for good', $client), $rec->done());
		}
		catch (Exception $e) {
			$this->toList(_s('Client "%1$s" was not deleted', $client), $rec->done(), true, $e->getMessage());
		}
	}
}
