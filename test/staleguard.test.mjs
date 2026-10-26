import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, parseConfig } from "../src/config.mjs";
import { formatAge, parseDuration } from "../src/duration.mjs";
import { evaluate } from "../src/evaluate.mjs";
import { run } from "../src/main.mjs";
import { composeText } from "../src/notify.mjs";
import { pick, probe, toDate } from "../src/probe.mjs";

const NOW = new Date("2026-10-26T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const tmp = () => mkdtempSync(join(tmpdir(), "staleguard-"));

/** Records outgoing requests; `fail` decides per URL whether to answer 500. */
function fakeFetch({ fail = () => false, json = {} } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (json[url] !== undefined) return new Response(JSON.stringify(json[url]), { status: 200 });
    return new Response("{}", { status: fail(String(url)) ? 500 : 200 });
  };
  f.calls = calls;
  return f;
}

test("durations parse and format", () => {
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("1h30m"), 90 * MIN);
  assert.equal(parseDuration("1h 30m"), 90 * MIN);
  assert.equal(parseDuration("2d"), 48 * 60 * MIN);
  for (const bad of ["", "15", "15x", "0m", "m15", "1h-"]) assert.throws(() => parseDuration(bad), /duration/, bad);
  assert.equal(formatAge(47_000), "47s");
  assert.equal(formatAge(185 * MIN), "3h 05m");
  assert.equal(formatAge(52 * 60 * MIN), "2d 4h");
});

test("timestamps: ISO, epoch seconds, epoch milliseconds; dotted paths", () => {
  assert.equal(toDate("2026-10-26T11:00:00Z").toISOString(), "2026-10-26T11:00:00.000Z");
  assert.equal(toDate(1_793_000_000).getTime(), 1_793_000_000_000);
  assert.equal(toDate(1_793_000_000_000).getTime(), 1_793_000_000_000);
  assert.equal(toDate("yesterday"), null);
  assert.equal(toDate(true), null);
  assert.equal(pick({ a: { b: { c: 1 } } }, "a.b.c"), 1);
  assert.equal(pick({ a: 1 }, "a.b"), undefined);
  assert.equal(pick({}, "constructor"), undefined);
});

test("config validation", () => {
  const ok = parseConfig({ checks: [{ name: "job", file: "/x.json", field: "lastOkAt", maxAge: "1h" }], remindEvery: "6h" });
  assert.equal(ok.checks[0].maxAgeMs, 60 * MIN);
  assert.equal(ok.remindEveryMs, 360 * MIN);
  assert.equal(ok.telegram, null);
  const bad = [
    {},
    { checks: [] },
    { checks: [{ name: "a", maxAge: "1h" }] },
    { checks: [{ name: "a", file: "/x", url: "https://x", field: "f", maxAge: "1h" }] },
    { checks: [{ name: "a", file: "/x", maxAge: "1h" }] },
    { checks: [{ name: "a", url: "ftp://x", field: "f", maxAge: "1h" }] },
    { checks: [{ name: "a b", mtime: "/x", maxAge: "1h" }] },
    { checks: [{ name: "a", mtime: "/x", maxAge: "soon" }] },
    { checks: [{ name: "a", mtime: "/x", maxAge: "1h" }, { name: "a", mtime: "/y", maxAge: "1h" }] },
  ];
  for (const raw of bad) assert.throws(() => parseConfig(raw), ConfigError, JSON.stringify(raw));
  assert.throws(() => parseConfig({ checks: [{ name: "a", mtime: "/x", maxAge: "1h" }] }, { STALEGUARD_WEBHOOK_URL: "http://plain" }), /https/);
});

test("probe: file with a fresh, an old, a missing and a future timestamp", async () => {
  const dir = tmp();
  const file = (name, doc) => {
    const p = join(dir, name);
    writeFileSync(p, typeof doc === "string" ? doc : JSON.stringify(doc));
    return p;
  };
  const check = (target, field = "lastOkAt") => ({ name: "job", kind: "file", target, field, maxAgeMs: 60 * MIN });

  const fresh = await probe(check(file("a.json", { lastOkAt: ago(10 * MIN) })), { now: NOW });
  assert.equal(fresh.status, "fresh");
  assert.equal(fresh.ageMs, 10 * MIN);

  const old = await probe(check(file("b.json", { lastOkAt: ago(61 * MIN) })), { now: NOW });
  assert.deepEqual([old.status, old.reason], ["stale", "older than maxAge"]);

  const empty = await probe(check(file("c.json", { lastOkAt: null })), { now: NOW });
  assert.match(empty.reason, /empty or missing/);

  const future = await probe(check(file("d.json", { lastOkAt: ago(-10 * MIN) })), { now: NOW });
  assert.match(future.reason, /future/);

  const nested = await probe(check(file("e.json", { status: { ok: ago(MIN) } }), "status.ok"), { now: NOW });
  assert.equal(nested.status, "fresh");

  assert.match((await probe(check(join(dir, "nope.json")), { now: NOW })).reason, /not found/);
  assert.match((await probe(check(file("f.json", "{broken")), { now: NOW })).reason, /not valid JSON/);
});

test("probe: mtime and url", async () => {
  const dir = tmp();
  const p = join(dir, "backup.gz");
  writeFileSync(p, "x");
  const t = new Date(NOW - 2 * 60 * MIN);
  utimesSync(p, t, t);
  const m = await probe({ name: "backup", kind: "mtime", target: p, maxAgeMs: 26 * 60 * MIN }, { now: NOW });
  assert.equal(m.status, "fresh");

  const url = "https://status.example/health";
  const io = { fetch: fakeFetch({ json: { [url]: { lastOkAt: ago(5 * MIN) } } }) };
  const u = await probe({ name: "api", kind: "url", target: url, field: "lastOkAt", maxAgeMs: 15 * MIN }, { now: NOW, io });
  assert.equal(u.status, "fresh");
  const down = await probe({ name: "api", kind: "url", target: "https://down.example/", field: "x", maxAgeMs: MIN }, { now: NOW, io: { fetch: fakeFetch({ fail: () => true }) } });
  assert.match(down.reason, /HTTP 500/);
});

test("evaluate: edge-triggered alerts, reminders, recovery", () => {
  const r = (status) => ({ name: "job", status, reason: status === "stale" ? "older than maxAge" : null, lastOkAt: null, ageMs: null });
  const opts = (now) => ({ now, remindEveryMs: 60 * MIN });

  const first = evaluate([r("fresh")], {}, opts(NOW));
  assert.deepEqual(first.events, []);

  const goesStale = evaluate([r("stale")], first.next, opts(NOW));
  assert.deepEqual(goesStale.events.map((e) => e.type), ["stale"]);

  const quiet = evaluate([r("stale")], goesStale.next, opts(new Date(+NOW + 30 * MIN)));
  assert.deepEqual(quiet.events, []);

  const remind = evaluate([r("stale")], quiet.next, opts(new Date(+NOW + 61 * MIN)));
  assert.deepEqual(remind.events.map((e) => e.type), ["reminder"]);
  assert.equal(remind.events[0].since, NOW.toISOString());

  const back = evaluate([r("fresh")], remind.next, opts(new Date(+NOW + 90 * MIN)));
  assert.deepEqual(back.events.map((e) => e.type), ["recovered"]);

  const noReminders = evaluate([r("stale")], goesStale.next, { now: new Date(+NOW + 600 * MIN), remindEveryMs: null });
  assert.deepEqual(noReminders.events, []);
});

test("run: alerts once over every configured channel, then recovers; state survives between runs", async () => {
  const dir = tmp();
  const status = join(dir, "status.json");
  const cfg = parseConfig(
    { checks: [{ name: "invoices", file: status, field: "lastOkAt", maxAge: "1h" }], hostLabel: "server-1" },
    { STALEGUARD_STATE_FILE: join(dir, "state.json"), STALEGUARD_TELEGRAM_BOT_TOKEN: "123:abc", STALEGUARD_TELEGRAM_CHAT_ID: "42", STALEGUARD_WEBHOOK_URL: "https://hooks.example/alert" },
  );
  const quiet = { log: () => undefined };

  writeFileSync(status, JSON.stringify({ lastOkAt: ago(2 * 60 * MIN) }));
  const f1 = fakeFetch();
  const r1 = await run(cfg, { ...quiet, now: NOW, fetch: f1 });
  assert.equal(r1.ok, false);
  assert.equal(f1.calls.length, 2);
  assert.match(f1.calls[0].body.text, /^STALE: invoices on server-1\nReason: older than maxAge/);
  assert.equal(f1.calls[1].url, "https://hooks.example/alert");
  assert.equal(f1.calls[1].body.event, "stale");
  assert.equal(f1.calls[1].body.ageSeconds, 7200);

  const f2 = fakeFetch();
  await run(cfg, { ...quiet, now: new Date(+NOW + 15 * MIN), fetch: f2 });
  assert.equal(f2.calls.length, 0, "no repeat alert without remindEvery");

  writeFileSync(status, JSON.stringify({ lastOkAt: new Date(+NOW + 29 * MIN).toISOString() }));
  const f3 = fakeFetch();
  const r3 = await run(cfg, { ...quiet, now: new Date(+NOW + 30 * MIN), fetch: f3 });
  assert.equal(r3.ok, true);
  assert.match(f3.calls[0].body.text, /^RECOVERED: invoices/);
  assert.match(f3.calls[0].body.text, /Was stale for 30m/);
  assert.equal(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).checks.invoices.status, "fresh");
});

test("run: a failed delivery is retried on the next run; dry run sends and stores nothing", async () => {
  const dir = tmp();
  const cfg = parseConfig(
    { checks: [{ name: "job", mtime: join(dir, "missing"), maxAge: "1h" }] },
    { STALEGUARD_STATE_FILE: join(dir, "state.json"), STALEGUARD_WEBHOOK_URL: "https://hooks.example/alert" },
  );
  const quiet = { log: () => undefined };

  const dry = fakeFetch();
  await run(cfg, { ...quiet, now: NOW, fetch: dry, dryRun: true });
  assert.equal(dry.calls.length, 0);

  const broken = fakeFetch({ fail: () => true });
  const r1 = await run(cfg, { ...quiet, now: NOW, fetch: broken });
  assert.equal(r1.failed.length, 1);

  const ok = fakeFetch();
  await run(cfg, { ...quiet, now: new Date(+NOW + MIN), fetch: ok });
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].body.event, "stale");
  assert.equal(ok.calls[0].body.since, NOW.toISOString(), "keeps the original start time");
});

test("run: heartbeat only when everything is fresh", async () => {
  const dir = tmp();
  const status = join(dir, "s.json");
  writeFileSync(status, JSON.stringify({ t: ago(MIN) }));
  const cfg = parseConfig(
    { checks: [{ name: "job", file: status, field: "t", maxAge: "10m" }], heartbeatUrl: "https://ping.example/abc" },
    { STALEGUARD_STATE_FILE: join(dir, "state.json") },
  );
  const f = fakeFetch();
  await run(cfg, { log: () => undefined, now: NOW, fetch: f });
  assert.deepEqual(f.calls.map((c) => c.url), ["https://ping.example/abc"]);
  writeFileSync(status, JSON.stringify({ t: ago(60 * MIN) }));
  const g = fakeFetch();
  await run(cfg, { log: () => undefined, now: NOW, fetch: g });
  assert.deepEqual(g.calls.map((c) => c.url), []);
});

test("alert text never includes secrets", () => {
  const text = composeText(
    { type: "stale", since: NOW.toISOString(), result: { name: "job", reason: "cannot read signal: HTTP 500", lastOkAt: null, ageMs: null } },
    { now: NOW },
  );
  assert.equal(text, "STALE: job\nReason: cannot read signal: HTTP 500\nLast success: unknown");
});
