# spritewright-auth: the service behind "Sign in with GitHub"

A static page cannot sign users in with GitHub on its own: GitHub exchanges the login code for an access token using a client **secret**, and that endpoint has no CORS. This tiny Cloudflare Worker holds the secret, does the exchange, hands the token to the spritewright page that opened the popup, and forgets it. It stores nothing and logs nothing. ~100 lines, no dependencies, tested in `test/worker.test.mjs`.

What the person using spritewright gets: click **Sign in with GitHub**, sign in on github.com as usual (SSO and 2FA included), and the editor can read their private repositories and open pull requests as them. No tokens to create or paste.

## One-time setup (about 10 minutes)

### 1. Create a GitHub App
**Fast path:** after deploying the Worker once (step 3), run `node worker/create-app.mjs --worker https://<your-worker-url>` and open http://localhost:8737/. It sends GitHub a pre-filled app definition; you press **Create GitHub App**, and the script writes the Client ID into `wrangler.toml`, stores the client secret as a Worker secret (never printed), and redeploys. Then do step 2.

By hand: GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.

| Field | Value |
| --- | --- |
| Name | `spritewright` (must be unique on GitHub, so pick your own) |
| Homepage URL | `https://snowu.github.io/spritewright/` |
| Callback URL | `https://<your-worker>.workers.dev/callback` (you get the host in step 3; you can edit it afterwards) |
| Expire user authorization tokens | **on** (default): tokens last 8 hours |
| Request user authorization (OAuth) during installation | off |
| Webhook | **uncheck Active** |
| Repository permissions | **Contents: Read and write**, **Pull requests: Read and write** (Metadata: Read-only is added automatically) |
| Where can this app be installed? | *Any account* if artists outside your account will use it, otherwise *Only on this account* |

Create it, then note the **Client ID** and use **Generate a new client secret**.

Why a GitHub App and not an OAuth App: an OAuth App's `repo` scope means "all your repositories". A GitHub App only reaches the repositories you install it on, with exactly the two permissions above, and its tokens expire.

### 2. Install the app on the repositories artists will edit
App settings → **Install App** → choose the repository (for example your game). Collaborators who sign in can then use the editor on exactly those repositories.

### 3. Deploy this Worker
```sh
cd worker
# put the app's Client ID in wrangler.toml (GITHUB_CLIENT_ID) and your page origin in ALLOWED_ORIGINS
npx wrangler secret put GITHUB_CLIENT_SECRET     # paste the client secret
npx wrangler secret put STATE_SECRET             # paste any long random string (openssl rand -hex 32)
npx wrangler deploy
```
Wrangler prints the Worker URL. Put `<that url>/callback` into the GitHub App's **Callback URL**.

### 4. Tell the page where the service is
Open the editor with `?auth=https://<your-worker>.workers.dev`, or set `DEFAULT_AUTH_BASE` in `index.html`, or pass `authBase` to `Spritewright.mount`.

Check it with `curl https://<your-worker>.workers.dev/health` (should print `{"ok":true}`).

## How it stays safe
- `/login` only accepts origins listed in `ALLOWED_ORIGINS`. The origin and a random nonce from the page are packed into a **signed, 10-minute `state`** (HMAC-SHA256 with `STATE_SECRET`); `/callback` rejects anything unsigned, tampered, expired or for an origin that is not allowed.
- The token is posted to the popup's opener with `postMessage` **only to that verified origin**, and the page only accepts a message from the service's origin that carries its own nonce.
- The refresh token and the client secret never reach the page. Responses are `no-store` with a strict CSP.
- Anything the user or GitHub supplies in an error message is JSON-escaped before it goes into the page.

## Limits
- Tokens last 8 hours; after that the editor asks the person to sign in again (refresh is not implemented).
- A GitHub App token only reaches repositories the app is installed on (plus public ones). If someone can see a repo but the app is not installed there, the editor says so.
- Creating a **fork** for a contributor without write access is not supported with app tokens; those contributors need write access or a pull request from a fork made on github.com.
- Organisations with SAML SSO may need to approve the app once.
- Not tested against the live GitHub login yet (the Worker and the page are tested against mocks). Do one real sign-in after setup.

## Local development
```sh
npx wrangler dev        # serves on http://localhost:8787
```
Add `http://localhost:5173` (or wherever you serve the editor) to `ALLOWED_ORIGINS` and the dev callback URL to the GitHub App.
