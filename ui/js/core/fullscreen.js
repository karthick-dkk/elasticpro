/**
 * Browser full screen for Play (docs/PLAY.md). One definition of "can we, are we, did Play
 * start it", used by the ▶ Play button, the Play page's toggle and F key, and the route
 * change that leaves Play.
 *
 * A refusal is never an error: no API (old Safari has only the webkit prefix), a frame that
 * does not allow it, a request outside a user gesture — each resolves to `false` and Play
 * carries on in the window it has.
 */

const KEY = 'ep.play.fsHintDismissed';

export function createFullscreen(doc = document) {
  const root = () => doc.documentElement;
  let ours = false;                      // Play asked for it (and it was granted)
  const subs = new Set();

  const element = () => doc.fullscreenElement || doc.webkitFullscreenElement || null;
  const reqFn = () => root() && (root().requestFullscreen || root().webkitRequestFullscreen);
  const exitFn = () => doc.exitFullscreen || doc.webkitExitFullscreen;

  /** Whether a toggle makes sense here: the API exists and the frame (if any) allows it. */
  function supported() {
    if (!reqFn()) return false;
    const fe = doc.fullscreenEnabled !== undefined ? doc.fullscreenEnabled : doc.webkitFullscreenEnabled;
    return fe !== false;
  }
  const active = () => !!element();

  async function request() {
    if (!supported() || active()) return active();
    try {
      await reqFn().call(root());
      ours = true;
      return true;
    } catch (_) { return false; }
  }
  async function exit() {
    if (!active()) return false;
    const f = exitFn();
    if (!f) return false;
    try { await f.call(doc); } catch (_) { return false; }
    return true;
  }
  const toggle = () => (active() ? exit() : request());
  /** Leaving Play: give the screen back only if Play took it. */
  async function leavePlay() {
    const mine = ours;
    ours = false;
    if (mine) await exit();
  }
  function changed() {
    if (!active()) ours = false;         // Esc or the browser left: nothing of ours remains
    for (const fn of subs) { try { fn(active()); } catch (_) { /* a listener must not break the rest */ } }
  }
  doc.addEventListener('fullscreenchange', changed);
  doc.addEventListener('webkitfullscreenchange', changed);

  return {
    supported, active, request, exit, toggle, leavePlay,
    ours: () => ours,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

export const hintDismissed = (store = globalThis.localStorage) => {
  try { return store.getItem(KEY) === '1'; } catch (_) { return false; }
};
export const dismissHint = (store = globalThis.localStorage) => {
  try { store.setItem(KEY, '1'); } catch (_) { /* private mode: it shows again, harmlessly */ }
};

/** The shared instance for the page's own document. */
let shared = null;
export function fullscreen() {
  if (!shared) shared = createFullscreen(document);
  return shared;
}
