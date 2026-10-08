<?php declare(strict_types = 0);

namespace Modules\EpCapacity\Lib;

use CDiv;
use CSpan;
use CTag;

/**
 * A figure with its percentage drawn beside it, for the widget tables.
 *
 * Copied from ../../shared/php by ../../sync-assets.mjs — edit it there.
 *
 * One definition for every widget: the percentage handed in here is the same $usage the cell's
 * colour was chosen from, so the bar and the colour can never tell different stories. The
 * thresholds are not repeated — the caller has already turned them into the cell's class, and
 * the bar simply takes its colour from that class in CSS.
 *
 * A null percentage draws no bar at all. That is the point of it being nullable: Elasticsearch
 * cannot always report a figure, and a bar of zero length reads as nought per cent, which is a
 * measurement nobody made.
 */
class Bars {

	/** The styles the widget's Display setting offers. 'none' draws the value and nothing else. */
	public const STYLES = ['under', 'cell', 'segments', 'none'];

	/**
	 * Bars under the value: the most legible down a column, because every bar starts at the
	 * same left edge. It lives here beside STYLES rather than on each widget's form, so the
	 * default and the list of styles cannot drift apart.
	 */
	public const DEFAULT_STYLE = 'under';

	/** How many lit-or-unlit blocks the segmented style draws. */
	private const SEGMENTS = 12;

	/**
	 * $content as the cell should render it: untouched when there is no percentage to draw or
	 * the widget is set to numbers only, else wrapped with the bar in the chosen style.
	 *
	 * @param mixed       $content  the cell's text, or the nodes making it up
	 * @param float|null  $pct      0-100, or null when the figure was not reported
	 * @param string      $style    one of STYLES
	 */
	public static function cell($content, ?float $pct, string $style, string $class = '') {
		if ($pct === null || $style === 'none' || !in_array($style, self::STYLES, true)) {
			return $content;
		}
		$pct = max(0.0, min(100.0, $pct));
		$width = rtrim(rtrim(number_format($pct, 2, '.', ''), '0'), '.');

		if ($style === 'segments') {
			$lit = (int) floor($pct / (100 / self::SEGMENTS) + 1e-9);
			$segs = [];
			for ($i = 0; $i < self::SEGMENTS; $i++) {
				$segs[] = (new CTag('i', true, ''))->addClass($i < $lit ? 'ep-seg-on' : null);
			}
			return (new CDiv([(new CSpan($segs))->addClass('ep-bar-segs'), (new CSpan($content))->addClass('ep-bar-val')]))
				->addClass('ep-bar-wrap ep-bar-segmented');
		}

		// The track is a child rather than a background on the cell, so a cell that also carries
		// ep-short or ep-unset keeps its own styling and the bar sits inside it.
		$track = (new CDiv((new CDiv(''))->addClass('ep-bar-fill')->setAttribute('style', 'width:'.$width.'%')))
			->addClass('ep-bar-track');

		return $style === 'cell'
			? (new CDiv([$track, (new CSpan($content))->addClass('ep-bar-val')]))->addClass('ep-bar-wrap ep-bar-incell')
			: (new CDiv([(new CDiv((new CSpan($content))->addClass('ep-bar-val')))->addClass('ep-bar-line'), $track]))
				->addClass('ep-bar-wrap ep-bar-under');
	}
}
