# CLS login and session

CLS sits behind company SSO, which is Feishu web QR login; there is no device flow or local callback. So **the user logs in by scanning a QR code with their own phone**, and the browser is always headless (no window, no desktop, nobody at the machine). `gof cls login --qr` opens CLS in the installed Chrome or Edge (override with env `REQUIREMENT_AUTO_BROWSER` = absolute path) through a minimal built-in DevTools client, and screenshots the Feishu QR page. It only observes the `Authorization` header of the page's own CLS API requests, confirms it with `/api/userinfo`, then closes the browser. All later work is plain HTTP; no browser needed. Does not use Codex's built-in browser or computer use.

`gof` = `node <skill>/../../server/dist/gof.mjs`. Check both logins with `gof login check` (SKILL.md section 0); the commands below do the logging in.

```text
gof cls login --qr cls-login.png    # write the QR image into the working directory
gof cls session                     # check; after the scan, take the login and close the browser
```

- Every online `cls` command (`catalog`, `observe`, `run`, `read-draft`, `verify`) obtains the login silently itself; no prior `session` needed. Without a usable login it stops and says to run `cls login --qr`.
- `cls login` requires `--qr <png>`; there is no windowed login.
- `cls login --qr`: silent check first (up to 12 s); logged in -> `logged_in`, no image. Otherwise opens CLS headless, stops on the Feishu QR page, writes the PNG, returns `qr_ready`; the browser keeps waiting in the background. The command ends in ~20 s.
- The image lands in the working directory; lark-agent sends it with the reply. Send it to the user only, ask them to scan with the Feishu mobile app and confirm on the phone.
- After the user confirms, run `cls session` (up to ~25 s): it attaches to the waiting browser, takes the login, closes the browser normally (so session cookies persist), then deletes the image and its record.
- The QR expires in a few minutes (under 4 in practice). Run the same command for a fresh one; the same file name is replaced, but a file it did not create is never overwritten.
- After 15 minutes without a scan, the next command closes the waiting browser and deletes the image.
- `no_qr`: the page is not on a QR code (maybe logged in or redirecting); run `cls session` first.
- **Whoever scans is who logs in.** Send the QR to the user only, never to a group. The first account logged in for a user is bound; another account is refused afterwards.
- **Consent page (auto-click of 【授权】):** after the scan, Feishu stops at the consent page of CLS app `dsc_admin` ("请求以下飞书账号进行授权", with 【拒绝】 and 【授权】). Nobody clicks in a headless browser, so while waiting `cls session` checks every 0.7 s and clicks 【授权】 itself; the user needn't confirm again. Narrow rules: the page text must name `dsc_admin`; if an account is bound, the page must name that account; only a button whose text is exactly "授权", never 【拒绝】, once per login. Otherwise it does not click, exits as blocked with the reason (wrong app / wrong account) and leaves the browser. Page text is compared in memory only, never printed or stored.
- The agent never scans, types passwords, completes SSO, uses an API key or another account.

## Keeping the login

- It lives in the browser profile, so later tasks normally pass `login check` without a scan (a silent check takes ~1 s).
- This depends on starting the browser with `--restore-last-session`: SSO leaves session-only cookies that a normal exit drops. Do not remove this flag.
- The browser waiting for a scan is started `detached` so it outlives the command; silent-check browsers end with their command, leaving no orphans.
- Each start restores the previous tabs and closes spare blank ones.

## Several users on one computer

- **Account binding:** the CLS account (id and name only) of a user's first successful login is stored in `<user dir>/requirement-auto/cls/account.json`. Later logins and online commands compare it and refuse another account, naming the one to use but not leaking who the other account is. An unreadable `account.json` is a refusal, never "no pin yet", and nothing is clicked on the consent page without a readable pin name. It stops a wrong account from silently taking over; it does not prove the first login was the right person. Changing accounts: an admin clears that user's `cls/browser-profile` and `cls/account.json`, then the user logs in again. The agent never does this.
- Each user's browser is a separate process on its own profile; they can wait for scans at the same time without interfering.
- With `LARK_AGENT_USER_OPEN_ID` but no `LARK_AGENT_USER_DIR`, all commands refuse instead of falling back to a shared dir.

## Token and browser boundaries

- The token lives only in the command's memory: never on disk, in output, batch records or logs (a record with an auth field is rejected). Each command discards it and gets a new one from the browser.
- Browser data is under `<user dir>/requirement-auto/cls/browser-profile` (per user). It is the browser's own storage; this skill never reads its cookies, local storage or files.
- It watches request headers to `https://creative.centurygames.cn/api/` only; it never modifies, clicks, types into or reads the page. The one screenshot is the Feishu QR page, taken to be handed to the user.
- Run one user's `cls` commands one after another, never in parallel: one browser per profile at a time.
- Lost login: the command stops and requires a new `cls login --qr`. No other browser, account or permission workaround.

## Environment

- No desktop session or person at the bot's machine; the remote user scans on their own phone. The machine needs Chrome or Edge.
- The user's channel must be able to show images; if not, tell the user and stop. No other login method.
- HTTP requests come from Node, not the browser. Behind a corporate proxy, set `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY` in the runtime environment.
