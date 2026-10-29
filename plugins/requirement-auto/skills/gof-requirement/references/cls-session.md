# CLS login and session

CLS sits behind company SSO (Feishu web QR login), so the user logs in by scanning a QR code with their phone. `gof cls login --qr` opens CLS in the installed Chrome or Edge, headless (override with env `REQUIREMENT_AUTO_BROWSER` = absolute path), screenshots the Feishu QR page, then takes the `Authorization` header of the page's own CLS API calls and confirms it with `/api/userinfo`. Later work is plain HTTP.

The browser is the feishu plugin's (it holds the user's Feishu web session): Feishu is logged in first in it (`gof feishu authorize --qr`, SKILL.md section 0), and that scan normally covers CLS too.

```text
gof cls login --qr cls-login.png    # QR image into the working directory
gof cls session                     # check; after the scan, take the login and close the browser
```

- Online `cls` commands (`catalog`, `observe`, `run`, `read-draft`, `verify`) get the login themselves; without one they say to run `cls login --qr`.
- `cls login --qr`: silent check first (up to 12 s); logged in -> `logged_in`. Otherwise it stops on the Feishu QR page, writes the PNG and returns `qr_ready`; the browser waits in the background. `no_qr`: the page is not on a QR code; run `cls session` first.
- The image in the working directory is sent to the user with the reply. It expires in a few minutes; run the command again for a fresh one. After 15 minutes without a scan the waiting browser is closed.
- After the user confirms: `cls session` (~25 s) attaches to the waiting browser, presses 【授权】 on the `dsc_admin` consent page (only that app and, once bound, that account), takes the login and closes the browser so cookies persist.
- Whoever scans is who logs in. The first account is bound in `<user dir>/requirement-auto/cls/account.json`; another account is refused, naming the one to use. To change it, clear that file and the browser profile (`<user dir>/feishu/browser-profile`, which also signs Feishu web out), then log in again.

## Keeping the login

- It lives in the browser profile (`<user dir>/feishu/browser-profile`, the feishu plugin's), so later tasks normally pass without a scan. This relies on `--restore-last-session` (SSO cookies are session-only); keep that flag.
- One browser per profile: run one user's `cls` commands one after another. Different users' browsers do not interfere.
- With `LARK_AGENT_USER_OPEN_ID` but no `LARK_AGENT_USER_DIR`, commands refuse rather than share a dir.

## Environment

- Needs Chrome or Edge on the machine; nobody needs to be at it.
- Behind a corporate proxy set `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY`.
