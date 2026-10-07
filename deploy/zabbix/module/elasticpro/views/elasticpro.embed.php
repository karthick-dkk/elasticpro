<?php declare(strict_types = 1);
/**
 * @var CView $this
 * @var array $data  ['configured', 'frame_url', 'public_url', 'error']
 */

if (!$data['configured']) {
	$body = (new CDiv(CWebUser::getType() == USER_TYPE_SUPER_ADMIN
		? [
			_('ElasticPro is not connected yet. Pair it under '),
			new CLink(_('Administration → ElasticPro'),
				(new CUrl('zabbix.php'))->setArgument('action', 'elasticpro.link.edit')
			),
			_(' (or, managed on the server, copy modules/elasticpro/config.php.example to config.php).')
		]
		: _('ElasticPro is not connected yet. A Zabbix Super admin pairs it under Administration → ElasticPro.')
	))->addClass('ep-error');
}
elseif ($data['frame_url'] === null) {
	$body = (new CDiv([
		new CTag('b', true, _('ElasticPro could not sign you in.')),
		BR(),
		$data['error']
	]))->addClass('ep-error');
}
else {
	$body = (new CTag('iframe', true))
		->setAttribute('src', $data['frame_url'])
		->setAttribute('title', 'ElasticPro')
		->setAttribute('referrerpolicy', 'no-referrer')
		->setAttribute('allow', 'clipboard-write')
		->addClass('ep-frame');
}

// No setTitle(): that draws a heading over the frame, and the page is the frame. The
// browser tab still gets the name, from the response (see View::doAction).
(new CHtmlPage())
	->addItem((new CDiv($body))->addClass('ep-wrap'))
	->show();
$origin = '';
if ($data['public_url'] !== '') {
	$parts = parse_url($data['public_url']);
	if (isset($parts['scheme'], $parts['host'])) {
		$origin = $parts['scheme'].'://'.$parts['host'].(isset($parts['port']) ? ':'.$parts['port'] : '');
	}
}
?>
<script>
	/* The app in the frame asks for this when its session ends — the core restarted, or it
	   sat idle. Loading this page again mints a fresh one-time code for the same Zabbix user,
	   so the person is signed straight back in instead of meeting a login form.
	   Only the ElasticPro origin is listened to, and at most three times a minute: a
	   sign-in that keeps failing must end in its error, not in a page that reloads forever. */
	(function () {
		var origin = <?= json_encode($origin) ?>;
		window.addEventListener('message', function (e) {
			if (!origin || e.origin !== origin || !e.data) return;
			if (e.data.type !== 'elasticpro:reauth') return;
			var key = 'elasticpro.reauth', now = Date.now(), recent = [];
			try { recent = JSON.parse(sessionStorage.getItem(key) || '[]').filter(function (t) { return now - t < 60000; }); } catch (_) {}
			if (recent.length >= 3) {
				var box = document.querySelector('.ep-wrap');
				/* Name the likely cause. The old wording said only that it had retried
				   three times and to read the server log, which is true and useless: the
				   one condition that actually produces this loop is the two sides no
				   longer sharing a pairing secret — reinstall either half and the module
				   still believes it is paired, because its secret lives in the Zabbix
				   database while the core keeps its own in its data directory. That is a
				   permanent state no amount of reloading fixes, so say what to do. */
				if (box) box.innerHTML = '<div class="ep-error"><b>ElasticPro could not keep you signed in.</b><br>'
					+ 'It asked Zabbix to sign you in again three times in a minute, so it stopped retrying.<br><br>'
					+ 'This almost always means Zabbix and ElasticPro no longer share a pairing secret — '
					+ 'which happens when either side is reinstalled or its data reset, because Zabbix keeps '
					+ 'the secret in its database and ElasticPro keeps its half in its data directory. '
					+ 'Reloading will not fix that: a Zabbix Super admin has to re-pair the two under '
					+ '<b>Administration \u2192 ElasticPro</b>.<br><br>'
					+ 'The ElasticPro server log gives the exact reason on <code>/sso/zabbix</code> — '
					+ '<code>not_configured</code> (ElasticPro has no secret), <code>bad_signature</code> '
					+ '(the two secrets differ) or <code>stale</code> (the clocks disagree).</div>';
				return;
			}
			recent.push(now);
			try { sessionStorage.setItem(key, JSON.stringify(recent)); } catch (_) {}
			location.reload();
		});
	})();
</script>
<style>
	/* Full height, no Zabbix footer band under a short frame: the wrapper flex-fills the
	   main column and the frame fills the wrapper. Scoped to these pages only. */
	.wrapper > footer[role="contentinfo"] { display: none !important; }
	.wrapper main { padding: 0 !important; }
	.ep-wrap { display: flex; flex: 1 1 auto; min-height: calc(100vh - 60px); }
	.ep-frame { flex: 1 1 auto; width: 100%; min-height: calc(100vh - 60px); border: 0; }
	.ep-error { margin: 40px auto; max-width: 640px; padding: 14px 16px; border-radius: 4px;
	             border: 1px solid #e45959; background: #fef6f6; color: #7a2020; line-height: 1.6; }
</style>
