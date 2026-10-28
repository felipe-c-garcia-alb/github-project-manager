# github-project-manager

A small web app to manage several GitHub repositories from one place.

| Page | What it does |
| --- | --- |
| **Dashboard** (`/`) | Register repositories (`owner/repo` or GitHub URL). Each card shows the number of **branches**, **tags**, **open PRs**, **workflows**, **action runs** and **running** runs. |
| **Repository** (`/repo.html?repo=owner/repo`) | **Pull requests**: open/closed/all, each linking to GitHub. **Actions**: recent workflow runs. Expand a run to choose a job from a dropdown and see its steps and logs. Running workflows refresh automatically (live). **Branches**: list (default and protected badges), create from any branch, delete. |
| **Triggers & Flows** (`/actions.html`) | **Trigger** any `workflow_dispatch` workflow on a registered repo with a ref and inputs. **Flows**: chain steps such as *run `x` on repo `y` → on success run `z` on another repo*. Each step starts only when the previous run finishes with `success`. Otherwise the flow stops and the remaining steps are skipped. Executions are shown live. |

## Getting started

Requirements: Node.js 18+.

```bash
npm install
GITHUB_TOKEN=<your token> npm start
# open http://127.0.0.1:3000
```

### Configuration (environment variables)

| Variable | Default | Description |
| --- | --- | --- |
| `GITHUB_TOKEN` | – | Token used for all GitHub API calls. It stays on the server. Without it only public data can be read. |
| `PORT` | `3000` | HTTP port. |
| `HOST` | `127.0.0.1` | Interface to bind to. The app has no authentication, so only expose it on trusted networks. |
| `ALLOWED_HOSTS` | – | Comma-separated host names the app may be reached by, besides `localhost` and IP addresses (e.g. `gpm.example.com`). This protects against DNS rebinding. |
| `DATA_FILE` | `./data/db.json` | JSON file where registered repositories and flows are stored. |
| `GITHUB_API_URL` | `https://api.github.com` | API base URL (e.g. for GitHub Enterprise Server: `https://ghe.example.com/api/v3`). |

Token permissions (fine-grained token) for the repositories you register:

- **Contents**: read & write (branches/tags)
- **Pull requests**: read
- **Actions**: read & write (runs, logs, dispatching workflows)
- **Metadata**: read

### Notes

- Workflows can only be triggered if they declare an `on: workflow_dispatch` trigger.
- GitHub publishes a job's full log once the job finishes. While a job is running, the page updates its step progress live and fetches the log as soon as it's available.
- Flow executions are kept in memory, so restarting the server clears the execution history. Flow definitions are persisted.
- Only registered repositories can be accessed through the app's API.
- State-changing API calls must send `X-Requested-With: XMLHttpRequest`. The bundled frontend does this, and it blocks cross-site request forgery.

## Development

```bash
npm test   # runs the node:test suites in test/
```

Project layout:

- `src/github.js`: GitHub REST API client
- `src/store.js`: JSON-file persistence for repositories and flows
- `src/flowRunner.js`: runs flows (dispatch, find the run, wait for success, next step)
- `src/app.js`: Express app and REST API (`/api/...`)
- `src/server.js`: entry point
- `public/`: static frontend (dashboard, repository page, triggers & flows page)
