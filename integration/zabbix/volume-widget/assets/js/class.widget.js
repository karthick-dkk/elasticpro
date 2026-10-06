/*
 * Volume report widget. The table is drawn by the server (views/widget.view.php); the Type
 * filter and Columns dialog are ep-columns.js, the export ep-export.js — shared with the other
 * ElasticPro reports.
 */
class WidgetEpVolume extends CWidget {

	setContents(response) {
		super.setContents(response);
		window.EpColumns.init(this, this._body, response.ep_meta || null);
		window.EpExport.bind(this._body, response.export || null, 'volume-report', 'Volume report', () => window.EpColumns.typeOf(this._body));
	}
}
