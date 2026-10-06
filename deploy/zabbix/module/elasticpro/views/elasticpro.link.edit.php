<?php declare(strict_types = 1);
/**
 * Administration → ElasticPro.
 *
 * @var CView $this
 * @var array $data  ['status' => Settings::status(), 'zabbix_url', 'role_name', 'user_name',
 *                    'mode' => '' | 'edit' | 'repair']
 *
 * The secret and the token are never on this page: it shows only whether a secret is set,
 * when and by whom. Every value drawn goes through Zabbix's tag classes, which escape it.
 *
 * Not configured yet → the pairing form is the whole page (the manual form sits collapsed
 * under "Enter it by hand instead" — a <details> element, no JS needed). Once something is
 * configured — paired, entered by hand, or set by config.php — the page shows only "Current
 * settings"; the forms come back one at a time behind "Edit settings" (?mode=edit) or
 * "Re-pair" (?mode=repair), each with its own Cancel back to the summary. Both are plain GET
 * links: no inline script, nothing for Zabbix's CSP to refuse. config.php managing the
 * secret makes Edit and Re-pair moot — neither is shown; the summary says so and stays
 * read-only.
 */

$st = $data['status'];
$db = $st['db'];
$ff = $st['from_file'];
$mode = $data['mode'];

$edit_action_url = new CUrl('zabbix.php');
$edit_action_url->setArgument('action', 'elasticpro.link.edit');

$update_url = (new CUrl('zabbix.php'))->setArgument('action', 'elasticpro.link.update')->getUrl();
$csrf = CCsrfTokenHelper::get('elasticpro.link.update');

$form = function (string $op, string $id) use ($update_url, $csrf): CForm {
	return (new CForm('post', $update_url))
		->setId($id)
		->setAttribute('autocomplete', 'off')
		->addVar(CSRF_TOKEN_NAME, $csrf)
		->addVar('op', $op);
};

$src = function (bool $from_file): CSpan {
	return (new CSpan($from_file ? _('config.php') : _('stored in Zabbix')))->addClass('ep-src');
};

$when = $db['pairedAt'] > 0 ? zbx_date2str(DATE_TIME_FORMAT_SECONDS, $db['pairedAt']) : '';

// Whether there is anything configured at all, and whether config.php owns the secret (in
// which case Edit/Re-pair cannot apply — the file always wins over what either would save).
$configured = $st['secret_set'];
$file_owns_secret = $ff['secret'];
if ($file_owns_secret) {
	$mode = '';   // ?mode=… from an old link or a typed URL is simply moot here
}

// Status / "Current settings" ----------------------------------------------------------
if ($st['secret_set']) {
	if ($ff['secret']) {
		$secret_text = $db['secret_set']
			? _s('set · in config.php (in use) · also stored in Zabbix: %1$s %2$s by %3$s, used once config.php is removed',
				$db['mode'] === 'manual' ? _('entered') : _('paired'), $when, $db['pairedBy'])
			: _('set · in config.php');
	}
	else {
		$secret_text = _s('set · %1$s %2$s by %3$s', $db['mode'] === 'manual' ? _('entered') : _('paired'),
			$when, $db['pairedBy']
		);
	}
}
elseif ($st['secret_unreadable']) {
	$secret_text = _('stored, but no longer opens (Zabbix\'s session key changed?) — pair again');
}
else {
	$secret_text = _('not set');
}

$status = (new CFormGrid())
	->addItem([new CLabel(_('ElasticPro URL')), new CFormField([
		$st['public_url'] !== '' ? $st['public_url'] : _('not set'), ' ', $src($ff['public_url'])
	])]);
if ($st['core_url'] !== $st['public_url']) {
	$status->addItem([new CLabel(_('Server-side URL')), new CFormField([$st['core_url'], ' ', $src($ff['core_url'])])]);
}
$status
	->addItem([new CLabel(_('Verify TLS')), new CFormField([$st['verify_tls'] ? _('yes') : _('no'), ' ', $src($ff['verify_tls'])])])
	->addItem([new CLabel(_('Secret')), new CFormField($secret_text)]);
if ($db['mode'] === 'pair' && $db['zabbixUrl'] !== '') {
	$status->addItem([new CLabel(_('Paired as')), new CFormField($db['zabbixUrl'])]);
}

$test_btn = $form('test', 'ep-test')->addItem((new CSubmit('test', _('Test connection')))->addClass(ZBX_STYLE_BTN_ALT));
$unpair_btn = ($db['secret_set'] || $db['tokenId'] !== '')
	? $form('unpair', 'ep-unpair')
		->setAttribute('data-ep-confirm', _('Unpair? The secret stored here is removed and the API token the pairing made is deleted. ElasticPro sign-in from Zabbix stops unless config.php sets a secret.'))
		->addItem((new CSubmit('unpair', _('Unpair')))->addClass(ZBX_STYLE_BTN_ALT))
	: null;
$edit_btn = (new CRedirectButton(_('Edit settings'), (clone $edit_action_url)->setArgument('mode', 'edit')->getUrl()))
	->addClass(ZBX_STYLE_BTN_ALT);
$repair_btn = (new CRedirectButton(_('Re-pair'), (clone $edit_action_url)->setArgument('mode', 'repair')->getUrl()))
	->addClass(ZBX_STYLE_BTN_ALT);
$cancel_btn = (new CRedirectButton(_('Cancel'), $edit_action_url->getUrl()))->addClass(ZBX_STYLE_BTN_ALT);

$status_actions = (new CDiv(array_filter([
	$test_btn,
	$file_owns_secret ? null : $edit_btn,
	$file_owns_secret ? null : $repair_btn,
	$unpair_btn,
])))->addClass('ep-actions');

$file_note = null;
if ($st['file_present']) {
	$keys = array_keys(array_filter($ff));
	$file_note = (new CDiv($keys
		? _s('config.php is present in the module folder and wins for: %1$s. Those fields are read-only here; remove config.php (or those keys) to run on the settings stored in Zabbix. You can pair first — sign-in keeps using config.php until you remove it.', implode(', ', $keys))
		: _('config.php is present in the module folder but sets nothing that overrides these settings.')
	))->addClass('ep-note');
}

// Pair ------------------------------------------------------------------------------------
$pair = $form('pair', 'ep-pair')->addItem((new CFormGrid())
	->addItem([
		(new CLabel(_('Pairing code'), 'ep-code'))->setAsteriskMark(),
		new CFormField([
			(new CTextArea('code', ''))->setId('ep-code')->setRows(4)->setWidth(ZBX_TEXTAREA_BIG_WIDTH)
				->setAttribute('spellcheck', 'false')->setAttribute('placeholder', _('Paste the code from ElasticPro → Config → Zabbix → Pair with Zabbix')),
		])
	])
	->addItem([
		new CLabel(_('This Zabbix\'s address'), 'ep-zabbix-url'),
		new CFormField([
			(new CTextBox('zabbix_url', $data['zabbix_url']))->setId('ep-zabbix-url')->setWidth(ZBX_TEXTAREA_BIG_WIDTH),
			(new CDiv(_('The address people open Zabbix at. ElasticPro checks it against the one it was given when the code was made, and allows only it to frame the app.')))->addClass('ep-hint'),
		])
	])
	->addItem([
		new CLabel(_('API URL for ElasticPro'), 'ep-api-url'),
		new CFormField([
			(new CTextBox('api_url', ''))->setId('ep-api-url')->setWidth(ZBX_TEXTAREA_BIG_WIDTH)
				->setAttribute('placeholder', _('<this Zabbix\'s address>/api_jsonrpc.php')),
			(new CDiv(_('Only if ElasticPro reaches the Zabbix API at a different address.')))->addClass('ep-hint'),
		])
	])
	->addItem([
		new CLabel(_('Verify TLS'), 'ep-pair-verify'),
		new CFormField([
			(new CCheckBox('verify_tls', '1'))->setId('ep-pair-verify')->setChecked(true),
			(new CDiv(_('Check ElasticPro\'s certificate. Untick for a self-signed test certificate only.')))->addClass('ep-hint'),
		])
	])
	->addItem([
		new CLabel(''),
		new CFormField([(new CSubmit('pair', _('Pair'))), ' ', $mode === 'repair' ? $cancel_btn : null]),
	])
);

$pair_explain = (new CDiv(_s('Pairing creates or reuses the user role "%1$s" (API access, read-only methods only, no frontend) and the user "%2$s" (in a group with frontend access disabled, random password never shown), makes a new API token for it and hands the token to ElasticPro over a signed request. A re-pair makes a new token first and deletes the previous pairing\'s token only after ElasticPro accepted the new one.',
	$data['role_name'], $data['user_name']
)))->addClass('ep-hint');

// Manual ------------------------------------------------------------------------------------
$ep_box = (new CTextBox('ep_url', $ff['public_url'] ? $st['public_url'] : $db['epUrl']))
	->setId('ep-url')->setWidth(ZBX_TEXTAREA_BIG_WIDTH)->setAttribute('placeholder', 'https://elasticpro.example.com');
$verify_box = (new CCheckBox('verify_tls', '1'))->setId('ep-manual-verify')
	->setChecked($ff['verify_tls'] ? $st['verify_tls'] : $db['verifyTls']);
$secret_box = (new CPassBox('secret', '', 255))->setId('ep-secret')->setWidth(ZBX_TEXTAREA_BIG_WIDTH)
	->setAttribute('autocomplete', 'new-password')
	->setAttribute('placeholder', $db['secret_set'] ? _('set — leave empty to keep') : _('at least 32 characters'));
if ($ff['public_url']) {
	$ep_box->setReadonly(true);
}
if ($ff['verify_tls']) {
	$verify_box->setReadonly(true)->setEnabled(false);
}
if ($ff['secret']) {
	$secret_box->setReadonly(true)->setAttribute('placeholder', _('set in config.php'));
}

$manual = $form('manual', 'ep-manual')->addItem((new CFormGrid())
	->addItem([new CLabel(_('ElasticPro URL'), 'ep-url'), new CFormField([
		$ep_box, $ff['public_url'] ? (new CDiv(_('Set in config.php.')))->addClass('ep-hint') : null
	])])
	->addItem([new CLabel(_('Verify TLS'), 'ep-manual-verify'), new CFormField([
		$verify_box, $ff['verify_tls'] ? (new CDiv(_('Set in config.php.')))->addClass('ep-hint') : null
	])])
	->addItem([new CLabel(_('Secret'), 'ep-secret'), new CFormField([
		$secret_box,
		(new CDiv(_('The same value as ELASTICPRO_ZABBIX_SSO_SECRET on the ElasticPro core. Never shown again once saved.')))->addClass('ep-hint'),
	])])
	->addItem([new CLabel(''), new CFormField([(new CSubmit('save', _('Save')))->addClass(ZBX_STYLE_BTN_ALT), ' ', $mode === 'edit' ? $cancel_btn : null])])
);

// Page body, one state at a time -----------------------------------------------------------
$body = [new CTag('h4', true, _('Connection')), $file_note];

if (!$configured) {
	// First-time: the pairing form leads; the manual form is one click away, not a second
	// wall of fields next to it.
	$body[] = new CTag('h4', true, _('Pair with ElasticPro'));
	$body[] = $pair_explain;
	$body[] = $pair;
	$body[] = (new CTag('details', true, [
		(new CTag('summary', true, _('Enter it by hand instead')))->addClass('ep-disclosure'),
		(new CDiv(_('For an ElasticPro whose secret is managed on the server (ELASTICPRO_ZABBIX_SSO_SECRET). No Zabbix user or token is made; give ElasticPro its API token yourself.')))->addClass('ep-hint'),
		$manual,
	]))->addClass('ep-manual-details');
}
elseif ($mode === 'edit') {
	$body[] = new CTag('h4', true, _('Edit settings'));
	$body[] = (new CDiv(_('Change the ElasticPro URL, TLS check or secret stored here. Leave the secret empty to keep the one already stored.')))->addClass('ep-hint');
	$body[] = $manual;
}
elseif ($mode === 'repair') {
	$body[] = new CTag('h4', true, _('Re-pair with ElasticPro'));
	$body[] = $pair_explain;
	$body[] = $pair;
}
else {
	// Configured (paired, manual, or config.php) and neither form was asked for: the
	// summary only — this is the state that used to also show both forms underneath it.
	$body[] = new CTag('h4', true, _('Current settings'));
	$body[] = $status;
	$body[] = $status_actions;
}

(new CHtmlPage())
	->setTitle(_('ElasticPro'))
	->addItem((new CDiv($body))->addClass('ep-link'))
	->show();
?>
<script>
	document.querySelectorAll('form[data-ep-confirm]').forEach(function (f) {
		f.addEventListener('submit', function (e) {
			if (!window.confirm(f.getAttribute('data-ep-confirm'))) e.preventDefault();
		});
	});
</script>
<style>
	.ep-link { max-width: 960px; padding: 0 10px 20px; }
	.ep-link h4 { margin: 22px 0 8px; font-size: 14px; }
	.ep-link .ep-hint { margin-top: 4px; opacity: .75; line-height: 1.5; }
	.ep-link .ep-src { margin-left: 6px; opacity: .6; font-size: 11px; }
	.ep-link .ep-note { margin: 6px 0 10px; padding: 8px 10px; border-left: 3px solid #f2a33a; background: rgba(242,163,58,.08); line-height: 1.5; }
	.ep-link .ep-actions { display: flex; gap: 8px; margin: 10px 0 0; flex-wrap: wrap; }
	.ep-link .ep-actions form { display: inline; }
	.ep-link .ep-manual-details { margin-top: 18px; }
	.ep-link .ep-manual-details > .ep-hint { margin-top: 10px; }
	.ep-link .ep-disclosure { cursor: pointer; font-size: 13px; color: var(--blue-color, #2b5ea7); }
	.ep-link .ep-disclosure:hover { text-decoration: underline; }
</style>
