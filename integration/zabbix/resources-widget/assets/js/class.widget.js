/*
 * Client resources widget. The table is drawn by the server (views/widget.view.php); the
 * controls — Type filter, expanding a client, Columns, export — are ep-columns.js and
 * ep-export.js, shared with the other ElasticPro reports.
 */
class WidgetEpResources extends CWidget {

	setContents(response) {
		super.setContents(response);
		window.EpColumns.init(this, this._body, response.ep_meta || null);
		window.EpExport.bind(this._body, response.export || null, 'client-resources', 'Clients', () => window.EpColumns.typeOf(this._body));
	}
}
