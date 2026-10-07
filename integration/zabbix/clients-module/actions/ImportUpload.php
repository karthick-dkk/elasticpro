<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use CControllerResponseData;
use Exception;
use Modules\EpClients\Lib\{Csv, Store};

/**
 * Import clients.csv, servers.csv, or both. Every row is checked first; one error and nothing is
 * applied. With clean files:
 * a backup, then new clients added straight away (unless something overlaps), then the changes
 * to existing clients shown for a tick. Each client added is read back and compared.
 */
class ImportUpload extends Base {

	protected function init(): void {
		// The upload is a multipart POST; the token travels in the form and is checked here.
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return $this->validateInput([CSRF_TOKEN_NAME => 'string']);
	}

	protected function doAction(): void {
		$data = ['stage' => 'upload', 'file' => '', 'plan' => null, 'added' => [], 'backup' => null, 'pending' => [], 'error' => null,
			'store_ok' => Store::writable(), 'store_dir' => Store::dir()];

		if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
			if (!\CCsrfTokenHelper::check((string) $this->getInput(CSRF_TOKEN_NAME, ''), 'ep.clients.import')) {
				$data['error'] = _('The form expired. Choose the file again.');
			}
			else {
				$got = [];
				foreach (['csv', 'servers'] as $k) {
					if (isset($_FILES[$k]) && $_FILES[$k]['error'] === UPLOAD_ERR_OK && $_FILES[$k]['size'] > 0) {
						$got[$k] = ['name' => basename((string) $_FILES[$k]['name']), 'text' => (string) file_get_contents($_FILES[$k]['tmp_name'])];
					}
				}
				if (!$got) {
					$data['error'] = _('No file was received. Choose clients.csv, servers.csv or both, and press Check files.');
				}
				else {
					$data['file'] = implode(' + ', array_column($got, 'name'));
					$data = $this->process($got['csv']['text'] ?? null, $got['servers']['text'] ?? null, $data);
				}
			}
		}
		$response = new CControllerResponseData($data);
		$response->setTitle(_('Import clients'));
		$this->setResponse($response);
	}

	private function process(?string $clients, ?string $servers, array $data): array {
		$roles = $this->roles();
		$importer = $this->importer();
		$plan = $importer->analyze($clients !== null ? Csv::parse($clients, $roles) : null, $servers !== null ? Csv::parseServers($servers, $roles) : null);
		$data['plan'] = $plan;
		if ($plan['errors']) {
			$data['stage'] = 'errors';
			return $data;
		}
		if (!Store::writable()) {
			$data['stage'] = 'errors';
			$data['plan']['errors'][] = _s('Backups cannot be kept: %1$s is missing or not writable. Nothing was changed.', Store::dir());
			return $data;
		}
		// A backup before what is added now; what waits for a tick gets its own when it is applied.
		// Checking a file changes nothing, so it does not use up one of the three.
		$work = array_filter($plan['rows'], fn($r) => $r['status'] === 'new' && !$r['warnings']);
		if ($work) {
			// Backups::take() refuses outright, by throwing, when it finds no clients while the
			// backups already kept hold some: the clients are found by a template name and a host
			// tag that both changed when the product was renamed, so reading zero of them is far
			// likelier to be a lookup that missed than a site whose clients have all gone. It also
			// throws when the data folder cannot be written. Caught here because it was not — this
			// was the one caller of backup() with no try/catch around it, so the refusal left the
			// controller as an uncaught exception and Zabbix answered with a fatal-error page, which
			// is the one place the operator could not read the worded reason for it. Either way
			// there is no backup, so the import stops here with the reason in the plan's errors and
			// nothing is applied, exactly as the not-writable branch above does.
			try {
				$data['backup'] = $this->backup('Import '.$data['file']);
			}
			catch (Exception $e) {
				$data['stage'] = 'errors';
				$data['plan']['errors'][] = $e->getMessage();
				return $data;
			}
		}

		$spec = $this->spec();
		foreach ($plan['rows'] as $row) {
			if ($row['status'] !== 'new' || $row['warnings']) {
				continue;
			}
			$rec = $this->rec();
			['client' => $client] = $spec->fromForm($row['form']);
			try {
				$rec->apply($client);
				$this->noteChange($client['name'], 'imported');
				$data['added'][] = ['name' => $client['name'], 'done' => $rec->done(), 'problems' => $importer->verify($client)];
			}
			catch (Exception $e) {
				$data['added'][] = ['name' => $client['name'], 'done' => $rec->done(), 'problems' => [$e->getMessage()]];
			}
		}

		// What waits for a tick: changes, and new clients that overlap something.
		$pending = array_values(array_filter($plan['rows'], fn($r) => $r['status'] === 'update' || ($r['status'] === 'new' && $r['warnings'])));
		if ($pending) {
			$token = bin2hex(random_bytes(8));
			Store::write('pending-import.json', ['token' => $token, 'file' => $data['file'], 'at' => time(), 'rows' => $pending]);
			$data['token'] = $token;
		}
		$data['pending'] = $pending;
		$data['stage'] = 'done';
		return $data;
	}
}
