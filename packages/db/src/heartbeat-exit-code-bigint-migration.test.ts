import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

d("heartbeat_runs.exit_code bigint migration", () => {
  it("creates exit_code as bigint on a fresh database", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap899-bigint-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    const cols = await sql`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_name = 'heartbeat_runs' AND column_name = 'exit_code'
    `;
    expect(cols).toHaveLength(1);
    expect(cols[0].data_type).toBe("bigint");
  });

  it("persists unsigned Windows exit codes without rollback (4294967295, 3221225786)", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap899-write-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    const company = (
      await sql`INSERT INTO companies (name) VALUES ('WORA-899 bigint test') RETURNING id`
    )[0];
    const agent = (
      await sql`INSERT INTO agents (company_id, name) VALUES (${company.id}, 'wora-899-agent') RETURNING id`
    )[0];

    for (const exitCode of [4294967295, 3221225786]) {
      const run = (
        await sql`
          INSERT INTO heartbeat_runs (company_id, agent_id, status)
          VALUES (${company.id}, ${agent.id}, 'running')
          RETURNING id
        `
      )[0];
      await sql`
        UPDATE heartbeat_runs
        SET status = 'failed', finished_at = now(), exit_code = ${exitCode}
        WHERE id = ${run.id}
      `;
      const row = (await sql`SELECT status, finished_at, exit_code FROM heartbeat_runs WHERE id = ${run.id}`)[0];
      expect(row.status).toBe("failed");
      expect(row.finished_at).toBeInstanceOf(Date);
      expect(row.exit_code).toBe(BigInt(exitCode));
    }
  });
});
