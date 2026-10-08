// Stale page shell guard.
//
// The static host ignores query strings, so a cached index.html from an older
// deploy loads the CURRENT JavaScript. Such a shell may lack elements the
// current code needs. Before the app touches the DOM it compares two versions:
//   - BUILD_VERSION: the build stamps the commit (query parameter v) into this module's URL
//     (tools/build_site.js), so it names the JavaScript that is running;
//   - the shell version: the v parameter on the shell's own app.js script tag.
// When they differ, the page reloads once from a URL no cache has seen
// (cs_shell=<build>), which fetches the matching shell. If that still does not
// match, it stops with a visible message instead of half-starting.
// Unbuilt sources (local development) have no version and skip the check.

export const BUILD_VERSION = new URL(import.meta.url).searchParams.get('v');
const PARAM = 'cs_shell';

export function shellVersion(doc) {
  const src = doc.querySelector('script[type="module"][src*="app.js"]')?.getAttribute('src') || '';
  return new URL(src, 'http://shell.invalid/').searchParams.get('v');
}

// true: the shell matches (or no build version), start the app.
// false: a reload was requested or a notice is shown; do not start.
export function ensureCurrentShell(doc = document, loc = location, hist = history) {
  if (!BUILD_VERSION) return true;
  const url = new URL(loc.href);
  if (shellVersion(doc) === BUILD_VERSION) {
    if (url.searchParams.has(PARAM)) { url.searchParams.delete(PARAM); hist.replaceState(null, '', url.href); }
    return true;
  }
  if (url.searchParams.get(PARAM) !== BUILD_VERSION) {
    url.searchParams.set(PARAM, BUILD_VERSION);
    loc.replace(url.href);
    return false;
  }
  const note = doc.createElement('div');
  note.setAttribute('role', 'alert');
  note.style.cssText = 'position:fixed;inset:0;z-index:99;padding:24px;background:#14171d;color:#e6e9ef;font:16px/1.5 system-ui,sans-serif';
  note.textContent = 'Concept Sketcher was updated, but this device keeps showing an older page. Close the app or tab completely and open it again.';
  doc.body.appendChild(note);
  return false;
}
