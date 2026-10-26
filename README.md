# staleguard

[![ci](https://github.com/NEXTRIQ/staleguard/actions/workflows/ci.yml/badge.svg)](https://github.com/NEXTRIQ/staleguard/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

staleguard alerts you when a scheduled job stops succeeding. It does this by checking **when the job last
succeeded**, not whether it exited with code 0.

Exit codes are a weak signal for background work. A job can exit 0 after doing nothing because a token expired.
A timer can stop being scheduled after a deploy. A wrapper script can swallow the real error. In each case
nothing crashes, so nothing alerts, and you find out days later. staleguard asks a different question: _did this
job actually succeed recently enough?_

Zero runtime dependencies. One small Node.js process, written in strict TypeScript and run from a timer.

## How it works

Every job you care about leaves a trace of its last success. staleguard reads three kinds of trace:

| Check            | Signal                                  | Example                               |
| ---------------- | --------------------------------------- | ------------------------------------- |
| `file` + `field` | a timestamp inside a local JSON file    | `status.json` → `lastOkAt`            |
| `url` + `field`  | a timestamp inside a JSON HTTP response | `/health` → `jobs.sync.lastSuccessAt` |
| `mtime`          | the modification time of a file         | last backup archive                   |

When the timestamp is older than `maxAge`, the check is **stale**. Several other cases also count as stale,
because "we could not tell" must never look like "all good":

- the file or URL is missing
- the response is not JSON
- the field is missing
- the timestamp is more than 5 minutes in the future (clock skew or a bug in the job)

Timestamps can be ISO 8601 strings or epoch seconds/milliseconds. `field` takes a dotted path.

Alerts are **edge-triggered**:

- **STALE** once, when a check goes stale
- **STILL STALE** every `remindEvery` while it stays stale (optional)
- **RECOVERED** once, when it is fresh again, with how long it was down

If an alert cannot be delivered, the next run retries it. Exit code `0` means everything is fresh and every alert
was delivered, `1` means something is stale or an alert could not be delivered, `78` means a configuration
error, and `2` means an unexpected error.

### Who watches the watcher?

Set `STALEGUARD_HEARTBEAT_URL` to a dead man's switch, such as a [healthchecks.io](https://healthchecks.io) ping
URL. staleguard only pings it when **every** check is fresh. The external service therefore alerts in two cases:
when staleguard itself stops running, and when it keeps running while something stays red.

## Usage

```sh
staleguard [--config /etc/staleguard/staleguard.json] [--dry-run]   # probe, alert on changes
staleguard status [--config …]                                       # current freshness as JSON lines
```

`--dry-run` probes and logs but sends nothing and stores no state.

### Configuration

Checks live in a JSON file ([`staleguard.example.json`](staleguard.example.json)):

```json
{
  "hostLabel": "server-1",
  "remindEvery": "6h",
  "checks": [
    {
      "name": "invoice-forwarder",
      "file": "/var/lib/exact-forwarder/status.json",
      "field": "lastOkAt",
      "maxAge": "1h"
    },
    {
      "name": "nightly-db-backup",
      "mtime": "/var/backups/db/latest.sql.gz",
      "maxAge": "26h"
    },
    {
      "name": "public-api",
      "url": "https://api.example.com/health",
      "field": "jobs.sync.lastSuccessAt",
      "maxAge": "15m"
    }
  ]
}
```

Durations look like `90s`, `15m`, `1h30m` or `2d`. Secrets come only from the environment
([`env.example`](env.example)):

| Variable                                                       | Purpose                                  |
| -------------------------------------------------------------- | ---------------------------------------- |
| `STALEGUARD_TELEGRAM_BOT_TOKEN`, `STALEGUARD_TELEGRAM_CHAT_ID` | Telegram alerts                          |
| `STALEGUARD_WEBHOOK_URL`                                       | JSON `POST` per event, https only        |
| `STALEGUARD_HEARTBEAT_URL`                                     | dead man's switch, see above             |
| `STALEGUARD_STATE_FILE`                                        | default `/var/lib/staleguard/state.json` |

A webhook body carries `event` (`stale`, `reminder` or `recovered`), `check`, `host`, `reason`, `lastOkAt`,
`ageSeconds`, `since`, `at` and a ready-to-post `text`.

### Install with systemd

Requires Node.js 20 or newer at `/usr/bin/node`. The TypeScript sources compile to `dist/`; the build tools are
dev dependencies and are pruned again after the build.

```sh
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin staleguard
sudo git clone https://github.com/NEXTRIQ/staleguard.git /opt/staleguard
cd /opt/staleguard && sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
sudo install -d /etc/staleguard
sudo install -m 644 /opt/staleguard/staleguard.example.json /etc/staleguard/staleguard.json   # edit it
sudo install -m 600 /opt/staleguard/env.example /etc/staleguard/env                           # fill it in
sudo cp /opt/staleguard/deploy/systemd/staleguard.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now staleguard.timer
```

The unit runs as its own user with a read-only view of the system. It needs read access to the files it
checks.

To update, run `sudo git pull` in `/opt/staleguard` and repeat the `npm ci && npm run build && npm prune` line.

## Making your own jobs checkable

Write the status file at the end of every run, and only move the success timestamp when the work really
succeeded:

```js
writeFileSync(
  "status.json.tmp",
  JSON.stringify({ lastRunAt: now, lastOkAt: ok ? now : previous.lastOkAt, lastError }),
);
renameSync("status.json.tmp", "status.json"); // atomic: never a half-written file
```

[exact-forwarder](https://github.com/NEXTRIQ/exact-forwarder) follows this pattern.

## Development

Node.js 20 or newer. The code is strict TypeScript (`noUncheckedIndexedAccess`, no `any`), linted with
typescript-eslint's type-checked rules and formatted with Prettier.

```sh
npm ci
npm run check   # typecheck, lint, format check, tests
npm test        # compiles to dist/ and runs node:test; no network access
npm run build   # production build to dist/, without tests
npm start -- --config staleguard.example.json --dry-run
```

```
bin/staleguard.ts    CLI: argument parsing, exit codes
src/types.ts         domain types: checks, config, probe results, state, alert events
src/config.ts        config parsing and validation
src/duration.ts      "1h30m" <-> milliseconds
src/probe.ts         reads one signal; never throws
src/evaluate.ts      edge-triggered alert logic (pure)
src/notify.ts        alert text, Telegram, webhook
src/state.ts         state file: tolerant load, atomic save
src/main.ts          one run: probe, evaluate, deliver, persist
src/guards.ts        narrowing helpers for unknown values
test/                node:test suites, including the compiled CLI as a child process
```

## License

[MIT](LICENSE). Built by [NEXTRIQ](https://nextriq.nl).
