import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// Windows process exit codes are unsigned 32-bit (e.g. 0xFFFFFFFF = 4294967295,
// 0xC000013A as unsigned = 3221225786). Stored in an integer column, the final
// UPDATE of a heartbeat run fails with "integer out of range", rolling back the
// status transition and leaving zombie runs behind (WORA-899).
const UNSIGNED_EXIT_CODES = [4294967295, 3221225786];

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("bigint exit_code migration", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("creates heartbeat_runs.exit_code as bigint on a fresh database", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-bigint-exit-code-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await applyPendingMigrations(database.connectionString);

    const columns = await sql<{ data_type: string }[]>`
      SELECT "data_type" FROM "information_schema"."columns"
      WHERE "table_name" = 'heartbeat_runs' AND "column_name" = 'exit_code'
    `;
    expect(columns[0]!.data_type).toBe("bigint");
  }, 30_000);

  it("persists an unsigned exit code on the final run update without rollback", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-bigint-exit-code-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await applyPendingMigrations(database.connectionString);

    const companyId = randomUUID();
    const agentId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Bigint Exit Code', 'BEC')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "status")
      VALUES (${agentId}, ${companyId}, 'Exit Code Runner', 'idle')
    `;

    for (const exitCode of UNSIGNED_EXIT_CODES) {
      const runId = randomUUID();
      await sql`
        INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status", "started_at")
        VALUES (${runId}, ${companyId}, ${agentId}, 'running', now())
      `;

      // This is the exact statement that used to roll back with
      // "integer out of range" when exit_code exceeded 2^31 - 1.
      await sql`
        UPDATE "heartbeat_runs"
        SET "status" = 'succeeded', "exit_code" = ${exitCode}, "finished_at" = now()
        WHERE "id" = ${runId}
      `;

      const [run] = await sql<{ status: string; exit_code: string | null }[]>`
        SELECT "status", "exit_code"::text AS "exit_code" FROM "heartbeat_runs" WHERE "id" = ${runId}
      `;
      expect(run!.status).toBe("succeeded");
      expect(run!.exit_code).toBe(String(exitCode));
    }
  }, 30_000);
});
