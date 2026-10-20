// Starts a browser on a profile, lets go of it without closing it, and ends. Run in its own process by cls-session.test.ts:
// whether a browser survives the process that started it can only be seen from outside that process.
// Argument 3 is "detach" to let it outlive this process (what a browser waiting for a scan does) or "attach" for the default of a hidden browser.
import { openBrowser } from '../../src/gof/chromium.ts';

const [exe, profileDir, mode] = process.argv.slice(2);
const browser = await openBrowser({ exe: exe!, profileDir: profileDir!, detach: mode === 'detach' });
browser.cdp.close();
console.log('left');
