# github-project-manager

A small web app to manage several GitHub repositories from one place.

| Page | What it does |
| --- | --- |
| **Dashboard** (`/`) | Register repositories (`owner/repo` or GitHub URL). Each card shows the number of **branches**, **tags**, **open PRs**, **workflows**, **action runs** and **running** runs. |
| **Repository** (`/repo.html?repo=owner/repo`) | **Pull requests**: open/closed/all, each linking to GitHub. **Actions**: recent workflow runs. Expand a run to choose a job from a dropdown and see its steps and logs. Running workflows refresh automatically (live). **Branches**: list (default and protected badges), create from any branch, delete. |
| **Triggers & Flows** (`/actions.html`) | **Trigger** any `workflow_dispatch` workflow on a registered repo with a ref and inputs. **Flows**: chain steps such as *run `x` on repo `y` → on success run `z` on another repo*. Each step starts only when the previous run finishes with `success`. Otherwise the flow stops and the remaining steps are skipped. Executions are shown live. |

Every user signs in with their own account and stores their **own GitHub token** on the Settings page. The token is encrypted before it is stored and is never sent back to the browser. See [Security](#security).

## Run with Docker

```bash
# 1. Create the encryption key used for GitHub tokens (keep it out of the data volume and out of git).
mkdir -p secrets && chmod 700 secrets
openssl rand -base64 32 > secrets/token_encryption_key

# 2. Start the app.
ALLOWED_HOSTS=gpm.example.com docker compose up -d --build
```

- **Image:** a slim Node 22 image with production dependencies only, running as the non-root `node` user. It has a `HEALTHCHECK` that calls `/api/health`.
- **Data:** registered repositories, users (with encrypted tokens), flows and run history are stored in `/data/db.json`. That path is a named volume (`gpm-data`), so the data survives image upgrades and redeploys.
  - Without a volume, the file disappears whenever the container is recreated.
  - The file is written atomically with `0600` permissions.
  - Back it up with: `docker run --rm -v gpm-data:/data -v "$PWD":/backup busybox cp /data/db.json /backup/`
- **Key:** compose passes the key as a Docker secret (`TOKEN_ENCRYPTION_KEY_FILE=/run/secrets/token_encryption_key`).
  - With plain `docker compose` (not Swarm), the file is bind-mounted, so the container's `node` user (uid 1000) must be able to read it. Either `chown 1000 secrets/token_encryption_key`, or keep it readable inside a `0700` directory.
- **HTTPS is required.** The container refuses login and API requests that did not arrive over HTTPS. Pick one of two setups:
  - **Reverse proxy** (Traefik, Nginx, Caddy…) that terminates TLS and sends `X-Forwarded-Proto: https`. Keep `TRUST_PROXY` set to the number of proxies (default `1` in compose). Publish the container port only to the proxy; compose binds it to `127.0.0.1`.
  - **Built-in TLS:** mount a certificate and key, then set `TLS_CERT_FILE` and `TLS_KEY_FILE`. They are commented out in `docker-compose.yml`.

Without compose:

```bash
docker build -t github-project-manager .
docker run -d -p 127.0.0.1:3000:3000 -v gpm-data:/data \
  -v "$PWD/secrets/token_encryption_key:/run/secrets/token_encryption_key:ro" \
  -e TOKEN_ENCRYPTION_KEY_FILE=/run/secrets/token_encryption_key \
  -e TRUST_PROXY=1 -e ALLOWED_HOSTS=gpm.example.com \
  github-project-manager
```

**First sign-in:** open the app and create the first account; anyone can do this while no account exists, so do it right away. After that, sign-up is closed unless `ALLOW_SIGNUP=true`. Then open **Settings** and paste your GitHub token.

## Run without Docker

Requirements: Node.js 18+.

```bash
npm install
TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32) npm start
# open http://127.0.0.1:3000
```

Plain HTTP is accepted only from the same machine (loopback) for local development. Persist the key somewhere safe: tokens encrypted with a lost key cannot be recovered, and users will have to enter them again.

### Configuration (environment variables)

Every `*_KEY` variable can also be given as `<NAME>_FILE` pointing to a file (Docker secrets).

| Variable | Default | Description |
| --- | --- | --- |
| `TOKEN_ENCRYPTION_KEY` / `TOKEN_ENCRYPTION_KEY_FILE` | **required** | 32-byte key, base64 or hex (`openssl rand -base64 32`). Encrypts users' GitHub tokens. |
| `TOKEN_ENCRYPTION_PREVIOUS_KEYS` / `…_FILE` | – | Comma-separated old keys, used only to decrypt and re-encrypt during [key rotation](#rotating-the-encryption-key). |
| `REQUIRE_HTTPS` | `true` | Refuse API, login and token requests that did not arrive over HTTPS. Loopback requests without proxy headers are exempt. Also sends `Strict-Transport-Security`. |
| `TRUST_PROXY` | – | Trust `X-Forwarded-*` from a reverse proxy: `true`, a hop count (`1`), or IPs/CIDRs. [Express "trust proxy"](https://expressjs.com/en/guide/behind-proxies.html) syntax. |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | – | Serve HTTPS directly with this certificate and key (PEM). |
| `ALLOW_SIGNUP` | `false` | Allow new accounts after the first one. |
| `SESSION_TTL_HOURS` | `12` | Session lifetime. Sessions are in memory, so a restart signs everyone out. |
| `PORT` | `3000` | Listening port. |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Interface to bind to. |
| `ALLOWED_HOSTS` | – | Comma-separated host names the app may be reached by, besides `localhost` and IP addresses (e.g. `gpm.example.com`). This protects against DNS rebinding. |
| `DATA_FILE` | `./data/db.json` (`/data/db.json` in Docker) | JSON file with repositories, users, flows and run history. |
| `GITHUB_API_URL` | `https://api.github.com` | API base URL (e.g. GitHub Enterprise Server: `https://ghe.example.com/api/v3`). Must be `https://`; the app refuses to start otherwise. |

Token permissions (fine-grained token) for the repositories you register:

- **Contents**: read & write (branches/tags)
- **Pull requests**: read
- **Actions**: read & write (runs, logs, dispatching workflows)
- **Metadata**: read

### Notes

- **Shared vs private:** registered repositories are shared by all users. What each person can see and do is decided by their own token. Flows and flow run history are private to the user who created them.
- **Flow tokens:** a flow runs in the background with the token of the user who started it. The server decrypts it for each step.
- **Restarts:** flow run history is stored in the JSON file. Runs that were in progress when the server stopped are marked `interrupted`.
- **Dispatching:** workflows can only be triggered if they declare an `on: workflow_dispatch` trigger.
- **Logs:** GitHub publishes a job's full log once the job finishes. While a job is running, the page updates its step progress live and fetches the log as soon as it's available.
- **API scope:** only registered repositories can be accessed through the app's API.

## Security

- **Token encryption:** GitHub tokens are encrypted with **AES-256-GCM**. The key comes from `TOKEN_ENCRYPTION_KEY`, ideally a Docker secret, and is never written to the data volume.
  - Each ciphertext is bound to its user id, so it cannot be moved to another account.
  - Tampering is detected.
  - A copy of `db.json` alone does not reveal any token.
- **Token handling:** a token is checked against GitHub (`GET /user`) before it is saved.
  - The API only ever returns "token set", its last 4 characters, the GitHub login and when it was updated.
  - Tokens are never logged or included in error messages.
- **Passwords:** hashed with scrypt and a random salt.
- **Login protection:** sign-up and login are rate-limited (20 attempts per 15 minutes per client), and failed logins return a generic error.
- **Sessions:** the session cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` over HTTPS.
- **Request checks:** state-changing API calls must send `X-Requested-With: XMLHttpRequest`, which blocks cross-site request forgery. The `Host` header is checked against `ALLOWED_HOSTS`.
- **Transport:**
  - Browser → app: HTTPS is enforced, as described for `REQUIRE_HTTPS`.
  - App → GitHub: always HTTPS. An `http://` `GITHUB_API_URL` is rejected at startup.
- **Container:** runs as a non-root user; the data directory is `0700` and `db.json` is `0600`.

### Rotating the encryption key

1. Generate a new key: `openssl rand -base64 32 > secrets/token_encryption_key.new`.
2. Restart with the new key as `TOKEN_ENCRYPTION_KEY[_FILE]` and the old one in `TOKEN_ENCRYPTION_PREVIOUS_KEYS[_FILE]`. At startup every stored token is re-encrypted with the new key; the log reports how many.
3. Restart once more without `TOKEN_ENCRYPTION_PREVIOUS_KEYS` and delete the old key.

If the key is lost, stored tokens cannot be recovered. The app still starts and logs how many tokens are unreadable; each affected user is asked to save their token again on the Settings page.

## Development

```bash
npm test                    # runs the node:test suites in test/
DOCKER_TESTS=1 npm test     # also builds the image and checks the container becomes healthy
```

Project layout:

- `src/github.js`: GitHub REST API client
- `src/store.js`: JSON-file persistence for repositories, users, flows and run history
- `src/crypto.js`: AES-256-GCM token encryption and password hashing
- `src/tokens.js`, `src/sessions.js`: per-user GitHub tokens and login sessions
- `src/config.js`: environment configuration and validation
- `src/flowRunner.js`: runs flows (dispatch, find the run, wait for success, next step)
- `src/app.js`: Express app and REST API (`/api/...`)
- `src/server.js`: entry point (HTTP or HTTPS); `src/healthcheck.js`: Docker health check
- `public/`: static frontend (login, dashboard, repository page, triggers & flows page, settings)
