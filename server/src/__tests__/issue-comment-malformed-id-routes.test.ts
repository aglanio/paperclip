import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  companyMemberships,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import type { StorageService } from "../storage/types.js";

// Regression for WORA-827 evidence: a malformed (non-UUID) comment id used to
// reach Postgres as an equality probe and surface as a 500 with a Drizzle
// stack ("invalid input syntax for type uuid"). Path segments and pagination
// cursors that are not UUIDs must read as "not found" / empty pages instead.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres malformed comment id tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("malformed comment ids read as not found", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-comment-malformed-id-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  }, 180_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Malformed Comment Id Co",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "MAL-1",
      title: "Malformed comment id",
      status: "todo",
      priority: "medium",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user-1",
      status: "active",
      membershipRole: "owner",
    });
    return { companyId, issueId };
  }

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    const storage: StorageService = {
      provider: "local_disk",
      putFile: vi.fn(async () => {
        throw new Error("Unexpected storage.putFile call");
      }),
      getObject: vi.fn(async () => {
        throw new Error("Unexpected storage.getObject call");
      }),
      headObject: vi.fn(async () => ({ exists: false })),
      deleteObject: vi.fn(async () => undefined),
    };
    app.use("/api", issueRoutes(db, storage));
    app.use(errorHandler);
    return app;
  }

  it("GET comment with non-uuid id returns 404, not 500", async () => {
    const { companyId, issueId } = await seedIssue();
    const response = await request(createApp(companyId)).get(
      `/api/issues/${issueId}/comments/ea3e2bd2`,
    );
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Comment not found" });
  });

  it("DELETE comment with non-uuid id returns 404, not 500", async () => {
    const { companyId, issueId } = await seedIssue();
    const response = await request(createApp(companyId)).delete(
      `/api/issues/${issueId}/comments/not-a-uuid`,
    );
    expect(response.status).toBe(404);
  });

  it("comment pagination cursor that is not a uuid yields an empty page", async () => {
    const { companyId, issueId } = await seedIssue();
    const svc = issueService(db);
    const page = await svc.listComments(issueId, { order: "asc", afterCommentId: "ea3e2bd2" });
    expect(page).toEqual([]);
  });

  it("service getComment returns null for non-uuid ids", async () => {
    issueService(db);
    const result = await issueService(db).getComment("ea3e2bd2");
    expect(result).toBeNull();
  });
});
