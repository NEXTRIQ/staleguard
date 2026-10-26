// Runs the compiled CLI as a child process: exit codes and output format are its public contract.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Tests run from dist/test/, next to dist/bin/.
const BIN = fileURLToPath(new URL("../bin/staleguard.js", import.meta.url));

function cli(...args: string[]) {
  // Keep the caller's STALEGUARD_* settings out of the child.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("STALEGUARD_")),
  );
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env });
}

function configFile(doc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "staleguard-cli-"));
  const path = join(dir, "staleguard.json");
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

test("cli: a missing config exits 78", () => {
  const res = cli("--config", "/nonexistent/staleguard.json");
  assert.equal(res.status, 78);
  assert.equal(
    res.stderr,
    "staleguard: configuration error: config not found: /nonexistent/staleguard.json\n",
  );
});

test("cli: an unknown command exits 78 and never echoes a bot token", () => {
  const config = configFile({ checks: [{ name: "job", mtime: "/x", maxAge: "1h" }] });
  const res = cli("bot123456:AAH-secret_value", "--config", config);
  assert.equal(res.status, 78);
  assert.equal(res.stderr, "staleguard: configuration error: unknown command: bot<token>\n");
});

test("cli: status prints one JSON line per check and exits 1 when any is stale", () => {
  const dir = mkdtempSync(join(tmpdir(), "staleguard-cli-"));
  const present = join(dir, "present");
  writeFileSync(present, "x");
  const config = configFile({
    checks: [
      { name: "present", mtime: present, maxAge: "1h" },
      { name: "absent", mtime: join(dir, "absent"), maxAge: "1h" },
    ],
  });
  const res = cli("status", "--config", config);
  assert.equal(res.status, 1);
  const lines = res.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  const [fresh, stale] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(fresh);
  assert.deepEqual(Object.keys(fresh), ["name", "lastOkAt", "ageMs", "status", "reason", "age"]);
  assert.equal(fresh.status, "fresh");
  assert.match(String(fresh.age), /^\d+s$/);
  assert.deepEqual(stale, {
    name: "absent",
    lastOkAt: null,
    ageMs: null,
    status: "stale",
    reason: "cannot read signal: not found",
    age: null,
  });
});
