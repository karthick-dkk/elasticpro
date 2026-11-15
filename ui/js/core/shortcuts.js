/**
 * The keyboard shortcuts the app really has — the one list the "?" sheet draws from.
 * Each row names where it works; when a handler changes, change its row here.
 */
export const SHORTCUTS = [
  { keys: ['?'], does: 'Show this list', where: 'Anywhere outside a text field' },
  { keys: ['Esc'], does: 'Close the open dialog, menu or panel; leave REST full screen; leave Play', where: 'Anywhere' },
  { keys: ['r'], does: 'Refresh the selected clusters', where: 'Anywhere outside a text field' },
  { keys: ['Ctrl', 'Enter'], alt: ['⌘', 'Enter'], does: 'Run the request', where: 'REST, in the query editor' },
  { keys: ['Alt', 'T'], does: 'New request tab', where: 'REST' },
  { keys: ['/'], does: 'Find a setting', where: 'Config-Management' },
  { keys: ['↑', '↓'], does: 'Move between the alert groups and rows', where: 'Alerts, on a group or row toggle' },
  { keys: ['←', '→'], does: 'Step back / forward', where: 'Play' },
  { keys: ['Space'], does: 'Pause / resume', where: 'Play' },
  { keys: ['f'], does: 'Full screen', where: 'Play' },
  { keys: ['+', '-'], does: 'Zoom in / out', where: 'Play' },
];

/** True when a key press is the "?" that opens the sheet: not typing, no Ctrl/⌘/Alt. */
export function isHelpKey(e) {
  if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return false;
  const t = e.target;
  return !(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
}
