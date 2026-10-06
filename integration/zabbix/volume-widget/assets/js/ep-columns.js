/*
 * The ElasticPro reports' controls: the Columns dialog (rename, show / hide, reorder, and
 * — in Client resources — show a family's roles as their own sections), the Type filter, and
 * expanding a client into its servers.
 *
 * `meta` comes from the widget's controller: {report, action, token, canEdit, columns:
 * [{id, label, default, hidden, section}], families?: [{id, label, split}]}. Saving posts the
 * settings to the widget module's own action and redraws the widget; the settings are one for
 * everyone and apply to the table and to the export.
 *
 * Shared: sync-assets.mjs copies this into every widget's assets/js. Edit it here.
 */
window.EpColumns = {
	/* The chosen client type in this widget, '' for all. */
	typeOf(body) {
		const sel = body.querySelector('[data-ep-type-filter]');
		return sel ? sel.value : '';
	},

	init(widget, body, meta) {
		const sel = body.querySelector('[data-ep-type-filter]');
		if (sel) sel.addEventListener('change', () => this.applyType(body));
		for (const t of body.querySelectorAll('[data-ep-expand]')) {
			t.addEventListener('click', () => this.toggle(body, t.dataset.epExpand, t));
		}
		const all = body.querySelector('[data-ep-expand-all]');
		if (all) {
			all.addEventListener('click', () => {
				const open = all.dataset.open !== '1';
				all.dataset.open = open ? '1' : '0';
				all.textContent = open ? 'Collapse all' : 'Expand all';
				for (const t of body.querySelectorAll('[data-ep-expand]')) this.toggle(body, t.dataset.epExpand, t, open);
			});
		}
		// Servers tables: as wide as the report's visible part, whatever the report's own width.
		const size = () => this.fitServers(body);
		size();
		const scroller = body.querySelector('.ep-res-scroll');
		if (scroller && typeof ResizeObserver === 'function') new ResizeObserver(size).observe(scroller);
		const btn = body.querySelector('[data-ep-columns]');
		if (btn && meta && meta.canEdit) btn.addEventListener('click', () => this.dialog(widget, meta));
		else if (btn) btn.hidden = true;
	},

	applyType(body) {
		const t = this.typeOf(body);
		let shown = 0;
		for (const row of body.querySelectorAll('tbody tr[data-type]')) {
			const hide = t !== '' && row.dataset.type !== t;
			row.hidden = hide;
			if (!hide) shown++;
			for (const sub of body.querySelectorAll(`tr[data-parent="${CSS.escape(row.dataset.row || '')}"]`)) {
				if (hide) sub.hidden = true;
			}
		}
		const count = body.querySelector('[data-ep-count]');
		if (count) count.textContent = count.dataset.template.replace('%n', shown);
	},

	fitServers(body) {
		const scroller = body.querySelector('.ep-res-scroll');
		if (!scroller) return;
		const width = scroller.clientWidth;
		if (!width) return;
		for (const w of body.querySelectorAll('.ep-servers-wrap')) w.style.width = width + 'px';
	},

	toggle(body, id, trigger, force) {
		const open = force !== undefined ? force : trigger.getAttribute('aria-expanded') !== 'true';
		trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
		trigger.textContent = open ? '▾' : '▸';
		for (const sub of body.querySelectorAll(`tr[data-parent="${CSS.escape(id)}"]`)) sub.hidden = !open;
		if (open) this.fitServers(body);
	},

	/* The dialog, built here so it needs nothing from Zabbix beyond the page itself. */
	dialog(widget, meta) {
		const cols = meta.columns.map((c) => ({...c}));
		const split = new Set((meta.families || []).filter((f) => f.split).map((f) => f.id));
		const shade = document.createElement('div');
		shade.className = 'ep-modal-shade';
		const box = document.createElement('div');
		box.className = 'ep-modal';
		box.setAttribute('role', 'dialog');
		box.setAttribute('aria-modal', 'true');
		box.setAttribute('aria-label', 'Columns');
		shade.appendChild(box);

		const draw = () => {
			box.innerHTML = '';
			const h = document.createElement('h3');
			h.textContent = 'Columns — ' + meta.title;
			box.appendChild(h);
			if (meta.families && meta.families.length) {
				const fam = document.createElement('div');
				fam.className = 'ep-modal-families';
				fam.append('Show roles as their own sections: ');
				for (const f of meta.families) {
					const l = document.createElement('label');
					const cb = document.createElement('input');
					cb.type = 'checkbox';
					cb.checked = split.has(f.id);
					cb.addEventListener('change', () => { cb.checked ? split.add(f.id) : split.delete(f.id); });
					l.append(cb, ' ' + f.label);
					fam.appendChild(l);
				}
				const note = document.createElement('div');
				note.className = 'ep-modal-note';
				note.textContent = 'Changing this redraws the report with its own columns; names and order below apply to the columns shown now.';
				fam.appendChild(note);
				box.appendChild(fam);
			}
			const wrap = document.createElement('div');
			wrap.className = 'ep-modal-list';
			const table = document.createElement('table');
			table.innerHTML = '<thead><tr><th></th><th>Show</th><th>Section</th><th>Column name</th></tr></thead>';
			const tbody = document.createElement('tbody');
			cols.forEach((c, i) => {
				const tr = document.createElement('tr');
				const move = document.createElement('td');
				for (const [d, sym] of [[-1, '▲'], [1, '▼']]) {
					const b = document.createElement('button');
					b.type = 'button';
					b.className = 'btn-link';
					b.textContent = sym;
					b.setAttribute('aria-label', (d < 0 ? 'Move up: ' : 'Move down: ') + c.default);
					b.disabled = (d < 0 && i === 0) || (d > 0 && i === cols.length - 1);
					b.addEventListener('click', () => { [cols[i], cols[i + d]] = [cols[i + d], cols[i]]; draw(); });
					move.appendChild(b);
				}
				const show = document.createElement('td');
				const cb = document.createElement('input');
				cb.type = 'checkbox';
				cb.checked = !c.hidden;
				cb.setAttribute('aria-label', 'Show ' + c.default);
				cb.addEventListener('change', () => { c.hidden = !cb.checked; });
				show.appendChild(cb);
				const sec = document.createElement('td');
				sec.textContent = c.section || '';
				const name = document.createElement('td');
				const inp = document.createElement('input');
				inp.type = 'text';
				inp.value = c.label;
				inp.placeholder = c.default;
				inp.setAttribute('aria-label', 'Name for ' + c.default);
				inp.addEventListener('input', () => { c.label = inp.value; });
				name.appendChild(inp);
				tr.append(move, show, sec, name);
				tbody.appendChild(tr);
			});
			table.appendChild(tbody);
			wrap.appendChild(table);
			box.appendChild(wrap);

			const bar = document.createElement('div');
			bar.className = 'ep-modal-bar';
			const reset = this.button('Reset to default', 'btn-alt', () => this.post(widget, meta, {reset: 1}, shade));
			const cancel = this.button('Cancel', 'btn-alt', () => shade.remove());
			const save = this.button('Save', '', () => {
				const settings = {
					labels: Object.fromEntries(cols.filter((c) => c.label.trim() !== '' && c.label !== c.default).map((c) => [c.id, c.label.trim()])),
					hidden: cols.filter((c) => c.hidden).map((c) => c.id),
					order: cols.map((c) => c.id),
					split: [...split]
				};
				this.post(widget, meta, {settings: JSON.stringify(settings)}, shade);
			});
			const msg = document.createElement('span');
			msg.className = 'ep-modal-msg';
			bar.append(reset, msg, cancel, save);
			box.appendChild(bar);
		};
		draw();
		shade.addEventListener('keydown', (e) => { if (e.key === 'Escape') shade.remove(); });
		shade.addEventListener('click', (e) => { if (e.target === shade) shade.remove(); });
		document.body.appendChild(shade);
		const first = box.querySelector('input');
		if (first) first.focus();
	},

	button(label, cls, onClick) {
		const b = document.createElement('button');
		b.type = 'button';
		if (cls) b.className = cls;
		b.textContent = label;
		b.addEventListener('click', onClick);
		return b;
	},

	async post(widget, meta, fields, shade) {
		const body = new URLSearchParams({_csrf_token: meta.token, report: meta.report, ...fields});
		const msg = shade.querySelector('.ep-modal-msg');
		try {
			const res = await fetch(`zabbix.php?action=${encodeURIComponent(meta.action)}`, {method: 'POST', body, credentials: 'same-origin'});
			const data = await res.json();
			if (!data || !data.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
			shade.remove();
			if (typeof widget._startUpdating === 'function') widget._startUpdating();
			else location.reload();
		}
		catch (e) {
			if (msg) msg.textContent = 'Not saved: ' + e.message;
		}
	}
};
