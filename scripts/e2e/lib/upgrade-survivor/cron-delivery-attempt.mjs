import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";

const candidateCommit = "818dd85ae1892e4d63cd431ee00d3baff8e66be2";
const schemaSourceCommit = "74b88a509d19878c3f74886f67e648929c62aee8";
const schemaSha256 = "993e08e70b43a7a52e52eb95eda33c19832df4ee1ec4ef1fe4068a4caf38adc7";
const stage = process.argv[2];
assert(["seed", "upgraded", "doctor", "first", "second"].includes(stage));
const state = process.env.OPENCLAW_STATE_DIR;
const runtime = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
assert(state && runtime && artifacts && configPath, "Missing isolated survivor paths");
assert(path.resolve(state).startsWith(`${path.resolve(runtime)}/`));
assert(path.resolve(configPath).startsWith(`${path.resolve(state)}/`));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const proofPath = path.join(artifacts, "cron-delivery-attempt-proof.json");
const databasePath = path.join(state, "state", "openclaw.sqlite");
const storeKey = path.join(state, "cron", "jobs.json");
const modes = ["announce", "webhook"];
const startedAt = 1710000000000;
const stable = (value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.keys(value)
          .toSorted()
          .map((key) => [key, stable(value[key])]),
      )
    : value;
const baseline = readJson(path.join(artifacts, "baseline-package-identity.json"));
const candidate = readJson(path.join(artifacts, "candidate-package-identity.json"));
assert.equal(baseline.version, "2026.9.4");
assert.equal(candidate.buildInfo.commit, candidateCommit);
const compactIdentity = ({ version, buildInfo, sha256, integrity, files }) => ({
  version,
  commit: buildInfo.commit,
  sha256,
  integrity,
  applicationPayloadSha256: hash(JSON.stringify(files)),
});
const proof =
  stage === "seed"
    ? {
        contract:
          "legacy ambiguous one-shots are disabled as Unknown after schema-19 to schema-20 upgrade",
        baseline: compactIdentity(baseline),
        candidate: compactIdentity(candidate),
        fixture: {
          schemaVersion: 19,
          sourceCommit: schemaSourceCommit,
          schemaSha256,
          note: "Schema-19 operator-state specimen; published 2026.9.4 driver itself declares schema 17.",
        },
        stages: {},
      }
    : readJson(proofPath);
if (stage === "seed") {
  assert(!fs.existsSync(databasePath), "Refuse to overwrite an existing state database");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const config = readJson(configPath);
  config.gateway = {
    ...config.gateway,
    mode: "local",
    bind: "loopback",
    auth: { mode: "token", token: "upgrade-survivor-token" },
  };
  config.cron = { enabled: true };
  // This storage witness has no channel/plugin workload or model credentials.
  config.plugins = { enabled: false };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
const db = new DatabaseSync(databasePath, { readOnly: stage !== "seed" });
try {
  if (stage === "seed") {
    const sql = fs.readFileSync(new URL("./cron-delivery-schema19.sql", import.meta.url));
    assert.equal(hash(sql), schemaSha256, "Archived schema bytes changed");
    db.exec(sql.toString());
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      "INSERT INTO schema_meta VALUES ('primary', 'global', 19, NULL, '2026.9.6', ?, ?)",
    ).run(startedAt, startedAt);
    db.prepare(
      "INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '19', ?)",
    ).run(startedAt);
    db.exec("PRAGMA user_version = 19");
    for (const [index, mode] of modes.entries()) {
      const id = `p04-legacy-${mode}`;
      const receiptId = `${id}-receipt`;
      const job = {
        id,
        name: id,
        enabled: true,
        agentId: "main",
        createdAtMs: startedAt - 1000,
        deleteAfterRun: true,
        schedule: { kind: "at", at: new Date(startedAt).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "Synthetic P-04 legacy completion" },
        delivery:
          mode === "announce"
            ? { mode, channel: "telegram", to: "123" }
            : { mode, to: "https://example.invalid/p04-completion" },
        state: {},
      };
      const { enabled: _enabled, state: _state, ...definition } = job;
      const revision = `sha256:${createHash("sha256")
        .update(JSON.stringify(stable(definition)))
        .digest("base64url")}`;
      const runtimeState = {
        runningAtMs: startedAt,
        runningReceiptId: receiptId,
        nextRunAtMs: startedAt,
      };
      db.prepare(`INSERT INTO cron_jobs
        (store_key, job_id, name, enabled, agent_id, payload_kind, job_json,
         grant_definition_revision, grant_definition_generation, grant_definition_updated_at,
         state_json, runtime_updated_at_ms, schedule_identity, sort_order, updated_at)
        VALUES (?, ?, ?, 1, 'main', 'agentTurn', ?, ?, 1, ?, ?, ?, ?, ?, ?)`).run(
        storeKey,
        id,
        id,
        JSON.stringify(job),
        revision,
        startedAt,
        JSON.stringify(runtimeState),
        startedAt,
        JSON.stringify({ version: 2, enabled: true, schedule: job.schedule, hasTrigger: false }),
        index,
        startedAt,
      );
      db.prepare(`INSERT INTO cron_run_receipts
        (receipt_id, store_key, job_id, config_revision, agent_id, status, owner_pid,
         owner_start_time, started_at_ms, finished_at_ms, error_text)
        VALUES (?, ?, ?, ?, 'main', 'running', 2147483647, NULL, ?, NULL, NULL)`).run(
        receiptId,
        storeKey,
        id,
        revision,
        startedAt,
      );
    }
    db.exec("COMMIT");
  }
  const readRows = () => ({
    receipts: db.prepare("SELECT * FROM cron_run_receipts ORDER BY job_id").all(),
    jobs: db
      .prepare(
        "SELECT job_id, enabled, state_json FROM cron_jobs WHERE store_key = ? ORDER BY job_id",
      )
      .all(storeKey),
  });
  // Gateway cron starts asynchronously after readiness. Observe that lifecycle
  // transition, bounded by the existing startup budget, without invoking repair.
  if (stage === "first" || stage === "second") {
    const deadline = Date.now() + 90_000;
    while (readRows().receipts.some((row) => row.status === "running")) {
      assert(Date.now() < deadline, "Gateway did not settle the legacy interrupted receipts");
      await setTimeout(200);
    }
  }
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  const userVersion = db.prepare("PRAGMA user_version").get().user_version;
  const schemaVersion = db
    .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
    .get().schema_version;
  const contentVersion = JSON.parse(
    db
      .prepare(
        "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
      )
      .get().value_json,
  );
  const column =
    db
      .prepare("PRAGMA table_info(cron_run_receipts)")
      .all()
      .find((row) => row.name === "delivery_attempt_state") ?? null;
  assert.equal(userVersion, stage === "seed" ? 19 : 20);
  assert.equal(schemaVersion, userVersion);
  assert.equal(contentVersion, userVersion);
  assert.equal(column?.name ?? null, stage === "seed" ? null : "delivery_attempt_state");
  if (column) {
    assert.equal(column.notnull, 1);
    assert.equal(column.dflt_value, "'unknown'");
  }
  const rows = readRows();
  assert.equal(rows.receipts.length, 2, "Recovery created or removed a run receipt");
  assert.equal(rows.jobs.length, 2, "Recovery removed a legacy ambiguous one-shot");
  for (const [index, mode] of modes.entries()) {
    const receipt = rows.receipts[index];
    const job = rows.jobs[index];
    assert.equal(receipt.receipt_id, `p04-legacy-${mode}-receipt`);
    assert.equal(receipt.started_at_ms, startedAt);
    assert.equal(job.job_id, `p04-legacy-${mode}`);
    assert.equal(receipt.delivery_attempt_state, stage === "seed" ? undefined : "unknown");
    const jobState = JSON.parse(job.state_json);
    if (stage === "first" || stage === "second") {
      assert.equal(receipt.status, "interrupted");
      assert(Number.isSafeInteger(receipt.finished_at_ms));
      assert.equal(job.enabled, 0);
      assert.equal(jobState.lastRunStatus, "error");
      assert.equal(jobState.lastDeliveryStatus, "unknown");
      assert.equal(jobState.lastDelivered, false);
      assert.equal(jobState.runningAtMs, undefined);
      assert.equal(jobState.runningReceiptId, undefined);
      assert.equal(jobState.nextRunAtMs, undefined);
      assert.equal(jobState.startupCatchupAtMs, undefined);
    } else {
      assert.equal(receipt.status, "running");
      assert.equal(receipt.finished_at_ms, null);
      assert.equal(job.enabled, 1);
      assert.equal(jobState.runningReceiptId, receipt.receipt_id);
    }
  }
  // Publish only synthetic state and package digests, not isolated absolute paths.
  const observed = {
    userVersion,
    schemaVersion,
    contentVersion,
    column,
    receipts: rows.receipts.map(({ store_key: _storeKey, ...receipt }) => receipt),
    jobs: rows.jobs.map(({ state_json, ...job }) => ({ ...job, state: JSON.parse(state_json) })),
  };
  if (stage === "second") {
    assert.deepEqual(
      observed,
      proof.stages.first,
      "Restart changed settled receipt/recovery facts",
    );
  }
  if (stage === "doctor") {
    assert.deepEqual(observed, proof.stages.upgraded, "Doctor changed migrated receipts");
  }
  if (stage === "upgraded") {
    const installed = readJson(path.join(artifacts, "installed-package-identity.json"));
    proof.installed = compactIdentity(installed);
    assert.equal(
      proof.installed.applicationPayloadSha256,
      proof.candidate.applicationPayloadSha256,
    );
  }
  proof.stages[stage] = observed;
  fs.writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  console.log(
    `P-04 receipt witness: ${stage}; schema=${userVersion}; attempts=${rows.receipts.map((row) => row.delivery_attempt_state ?? "absent").join(",")}`,
  );
} finally {
  db.close();
}
