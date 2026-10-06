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
				if (box) box.innerHTML = '<div class="ep-error"><b>ElasticPro could not keep you signed in.</b><br>'
					+ 'It asked Zabbix to sign you in again three times in a minute. Reload this page to try again; '
					+ 'if it keeps happening, the ElasticPro server log says why.</div>';
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
