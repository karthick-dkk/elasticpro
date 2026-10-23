/**
 * `elasticpro-scrape.mjs --format sender`: the scrape document as one `zabbix_sender` input
 * line, to the same item the HTTP agent fills.
 *
 * The automation template (deploy/zabbix/template-elasticpro.yaml) has one master item,
 * `elasticpro.state`. Every other item and both discovery rules are dependents of it that
 * pick their figure out of the JSON. A dependent item has exactly one master, so the pushed
 * document goes to that same item: it is an HTTP agent item with trapping enabled
 * (`allow_traps`), which accepts a sender value as well as polling. Set the template macro
 * `{$ELASTICPRO.POLL}` to 0 on a host that is only pushed to, and the item never polls.
 *
 * Before this, the sender format sent one key per figure (`elasticpro.scrape.ok`,
 * `elasticpro.freed.bytes`, …) that the template did not have or that were dependent items,
 * so Zabbix rejected every value. tools/unit/scrape-sender.test.mjs checks each key emitted
 * here against the template.
 */

/** The template's master item: the HTTP agent that also accepts trapped values. */
export const SENDER_KEY = 'elasticpro.state';

/** A value as `zabbix_sender -i` reads it: in double quotes, with `\` and `"` escaped. */
export const senderQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The document → zabbix_sender input text (one line, with a trailing newline). */
export function senderLines(doc, host) {
  return `${host} ${SENDER_KEY} ${senderQuote(JSON.stringify(doc))}\n`;
}
