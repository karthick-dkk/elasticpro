/*
 * Export for the ElasticPro widgets — CSV and Excel from the rows a widget's controller
 * sends: plain numbers, bytes as GB, unknowns as empty cells, so a spreadsheet column can be
 * summed and a figure Zabbix did not have is never totalled as 0.
 *
 * `data` is {headers, rows, types?, servers?: {headers, rows, types?}}. `types` gives each row's
 * client type, so a Type filter chosen in the widget also narrows what is exported. With
 * `servers`, Excel gets a second sheet and "CSV (servers)" its own file.
 *
 * Shared: sync-assets.mjs copies this into every widget's assets/js. Edit it here.
 */
window.EpExport = {
	/* A cell that a spreadsheet would run as a formula is written as text. */
	safe(v) {
		if (v === null || v === undefined) return '';
		if (typeof v === 'number') return String(v);
		const s = String(v);
		return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
	},

	csv(headers, rows) {
		const field = (v) => {
			const s = this.safe(v);
			return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
		};
		return [headers, ...rows].map((r) => r.map(field).join(',')).join('\r\n') + '\r\n';
	},

	xlsxRows(headers, rows) {
		return [headers, ...rows.map((r) => r.map((v) => (typeof v === 'number' ? v : (v === null ? null : this.safe(v)))))];
	},

	filename(prefix, ext, now = new Date()) {
		const p = (n) => String(n).padStart(2, '0');
		return `${prefix}-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}.${ext}`;
	},

	/* Only the rows of the chosen client type ('' = all). */
	filtered(set, type) {
		if (!set || !type || !set.types) return set;
		return {headers: set.headers, rows: set.rows.filter((_, i) => set.types[i] === type), types: set.types.filter((t) => t === type)};
	},

	save(blob, name) {
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = name;
		document.body.appendChild(a);
		a.click();
		setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
	},

	/* Browser only: build the file and hand it to the viewer. */
	download(prefix, kind, sheet, data, type = '') {
		const main = this.filtered(data, type);
		const servers = this.filtered(data.servers || null, type);
		if (kind === 'xlsx') {
			const sheets = [{name: sheet, rows: this.xlsxRows(main.headers, main.rows)}];
			if (servers) sheets.push({name: 'Servers', rows: this.xlsxRows(servers.headers, servers.rows)});
			this.save(new Blob([window.EpXlsx.workbook(sheets)], {type: window.EpXlsx.XLSX_MIME}), this.filename(prefix, 'xlsx'));
			return;
		}
		const set = kind === 'csv-servers' ? servers : main;
		this.save(new Blob(['﻿' + this.csv(set.headers, set.rows)], {type: 'text/csv;charset=utf-8'}),
			this.filename(kind === 'csv-servers' ? `${prefix}-servers` : prefix, 'csv'));
	},

	/* Wire a widget body's [data-ep-export] buttons. `typeOf` returns the chosen type filter. */
	bind(body, data, prefix, sheet, typeOf = () => '') {
		for (const button of body.querySelectorAll('[data-ep-export]')) {
			button.disabled = !data || data.rows.length === 0;
			button.title = button.disabled ? 'Nothing to export yet — no rows in this widget' : '';
			button.addEventListener('click', () => this.download(prefix, button.dataset.epExport, sheet, data, typeOf()));
		}
	}
};
