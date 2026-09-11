import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "kysely";
import { setupDatabase } from "./database";
import { migrate } from "../scripts/migrate";
import { seedInstruments } from "../scripts/seed-instruments";
import { normalizeCampaigns } from "../scripts/close-campaigns";
import { ids } from "../scripts/seed";
import { withStaff } from "../src/db";
import { secret, digest, AppError } from "../src/security";
import {
  saveSeries,
  saveRound,
  saveCampaign,
  launchCampaign,
  campaignTransition,
  invitationAction,
  createLinkExport,
  linkExportKey,
  participation,
  launchReview,
  campaignDetail,
  getCampaign,
  linkExportCsv,
  type Campaign,
  type IssuedLink,
} from "../src/campaigns";
import { campaignInput, linkExportInput } from "../src/campaign-input";
import { tokenDigest, invitationUrl } from "../src/invitation-token";
import { getExport, cleanLocalExports } from "../src/link-storage";
import { exchange, status } from "../src/gateway";
import { generateCustodianKeypair } from "../src/key-custody";

const BUILTIN_VERSION = "44000000-0000-4000-9000-000000000001";
const BUILTIN_QUESTIONNAIRE = "44000000-0000-4000-8000-000000000001";
const failure = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (e) {
    return e instanceof AppError ? e.code : (e as Error).message;
  }
  return "NO_ERROR";
};
const hourFrom = (ms: number) => new Date(Date.now() + ms).toISOString();
// Scheduled-start checks wait for the real clock. starts_at is frozen at launch,
// so no operator edit can fabricate the boundary these tests are checking.
const START_DELAY_MS = 2000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("PostgreSQL campaigns: targeting, freezing, invitations, boundaries and links", async (t) => {
  // Real upgrade path: an existing populated database moves 007 -> 008.
  const fixture = await setupDatabase(undefined, true, "007_scoring_engine.sql");
  const upgrade = new pg.Client({
    connectionString: fixture.url("orgfit_migrator"),
  });
  await upgrade.connect();
  await upgrade.query("SET ROLE orgfit_core_owner");
  await upgrade.query(
    "insert into core.department(organization_id,code,name_ar) values($1,'PRESERVED','قسم محفوظ')",
    [ids.orgA],
  );
  await migrate(fixture.url("orgfit_migrator"));
  await seedInstruments(fixture.url("orgfit_migrator"));
  await migrate(fixture.url("orgfit_migrator"));
  assert.equal(
    (
      await upgrade.query(
        "select name_ar from core.department where code='PRESERVED'",
      )
    ).rows[0].name_ar,
    "قسم محفوظ",
    "the populated 007 -> 008 upgrade preserves earlier directory rows",
  );

  Object.assign(process.env, {
    NODE_ENV: "test",
    STAFF_ORIGIN: "http://127.0.0.1:3000",
    RESPONDENT_ORIGIN: "http://localhost:3001",
    DATABASE_URL: fixture.url("orgfit_staff"),
    AUTH_DATABASE_URL: fixture.url("orgfit_auth"),
    OIDC_ISSUER: "http://127.0.0.1:4010",
    OIDC_CLIENT_ID: "test",
    OIDC_CLIENT_SECRET: "synthetic-test-secret",
    OIDC_MFA_ACR: "urn:test:mfa",
    INVITATION_DIGEST_KEY: "a".repeat(64),
    INVITATION_DIGEST_KEY_VERSION: "test-v1",
    LINK_EXPORT_ENCRYPTION_KEY: "b".repeat(64),
    LINK_EXPORT_LOCAL_DIRECTORY: `work/link-exports-${randomUUID()}`,
    // Phase 07 made an authenticated campaign key a launch precondition: a
    // campaign must never be able to open for answers with nothing to seal an
    // acceptance to. Only the custodian's PUBLIC key belongs in this process.
    CAMPAIGN_KEY_CUSTODY_DIRECTORY: `work/key-custody-${randomUUID()}`,
    CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY: (await generateCustodianKeypair()).publicKey,
  });
  delete process.env.MIGRATION_DATABASE_URL;

  const auth = new pg.Client({ connectionString: fixture.url("orgfit_auth") }),
    operator = new pg.Client({
      connectionString: fixture.url("orgfit_migrator"),
    }),
    runtime = new pg.Client({ connectionString: fixture.url("orgfit_staff") });
  await Promise.all([auth.connect(), operator.connect(), runtime.connect()]);
  // The plain runtime credential must not reach campaign internals directly.
  await runtime.query("select 1");
  await operator.query("SET ROLE orgfit_core_owner");

  // Synthetic directory: two departments, one person with no department, one
  // archived person, and one person belonging to the other organization.
  const dept = { d1: randomUUID(), d2: randomUUID() };
  const people = {
    p1: randomUUID(),
    p2: randomUUID(),
    p3: randomUUID(),
    p4: randomUUID(),
    archived: randomUUID(),
    foreign: randomUUID(),
  };
  for (const [id, code, name] of [
    [dept.d1, "ENG", "الهندسة"],
    [dept.d2, "OPS", "العمليات"],
  ])
    await operator.query(
      "insert into core.department(id,organization_id,code,name_ar) values($1,$2,$3,$4)",
      [id, ids.orgA, code, name],
    );
  for (const [id, org, ref, name, department, personStatus] of [
    [people.p1, ids.orgA, "A-1", "مشارك ١", dept.d1, "ACTIVE"],
    [people.p2, ids.orgA, "A-2", "مشارك ٢", dept.d1, "ACTIVE"],
    [people.p3, ids.orgA, "A-3", "مشارك ٣", dept.d2, "ACTIVE"],
    [people.p4, ids.orgA, "A-4", "مشارك ٤", null, "ACTIVE"],
    [people.archived, ids.orgA, "A-5", "مشارك ٥", dept.d1, "ARCHIVED"],
    [people.foreign, ids.orgB, "A-1", "مشارك ب", null, "ACTIVE"],
  ] as const)
    await operator.query(
      "insert into core.participant(id,organization_id,private_reference,display_name,department_id,status) values($1,$2,$3,$4,$5,$6)",
      [id, org, ref, name, department, personStatus],
    );
  const family = (
    await operator.query(
      "select family_key from instrument.questionnaire where id=$1",
      [BUILTIN_QUESTIONNAIRE],
    )
  ).rows[0].family_key as string;

  const session = async (subject: string) => {
    const token = secret();
    await auth.query("select access.issue_session($1,$2,$3)", [
      process.env.OIDC_ISSUER,
      subject,
      digest(token),
    ]);
    return token;
  };
  let staff = await session("staff");
  const admin = await session("admin");

  let series: string, round: string, campaign: Campaign;
  const draftCampaign = async (
    body: Partial<Record<string, unknown>> = {},
    token = staff,
  ) => {
    const created = await withStaff(token, (tx) =>
      saveCampaign(
        tx,
        ids.orgA,
        null,
        null,
        campaignInput.parse({
          roundId: round,
          questionnaireVersionId: BUILTIN_VERSION,
          target: { mode: "SELECTED", participantIds: [people.p1, people.p2] },
          startsAt: hourFrom(3600_000),
          timezone: "Asia/Riyadh",
          ...body,
        }),
        randomUUID(),
      ),
    );
    return created;
  };
  const newRound = async (label: string) => {
    const created = await withStaff(staff, (tx) =>
      saveRound(
        tx,
        ids.orgA,
        null,
        null,
        {
          seriesId: series,
          label,
          periodStart: "2026-01-01",
          questionnaireVersionId: BUILTIN_VERSION,
          populationDefinition: { schemaVersion: 1 },
        },
        randomUUID(),
      ),
    );
    return created.id as string;
  };

  try {
    await t.test(
      "capability and organization boundaries deny campaign writes",
      async () => {
        // The staff fixture starts with directory.manage only.
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              saveSeries(
                tx,
                ids.orgA,
                null,
                null,
                {
                  nameAr: "سلسلة",
                  purpose: "غرض",
                  questionnaireFamilyId: family,
                },
                randomUUID(),
              ),
            ),
          ),
          "FORBIDDEN",
        );
        // No assignment to organization B, so it must not even be discoverable.
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              saveSeries(
                tx,
                ids.orgB,
                null,
                null,
                {
                  nameAr: "سلسلة",
                  purpose: "غرض",
                  questionnaireFamilyId: family,
                },
                randomUUID(),
              ),
            ),
          ),
          "NOT_FOUND",
        );
        for (const capability of [
          "campaigns.manage",
          "participation.read",
          "participation.export",
        ])
          await operator.query(
            "insert into access.staff_capability(staff_user_id,capability) values($1,$2)",
            [ids.staff, capability],
          );
        // Capability changes bump the auth epoch and revoke live sessions.
        assert.equal(
          await failure(() => withStaff(staff, async (_tx, p) => p)),
          "SESSION_REQUIRED",
        );
        staff = await session("staff");
      },
    );

    await t.test(
      "series and round validate lineage, published version and same-organization ownership",
      async () => {
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              saveSeries(
                tx,
                ids.orgA,
                null,
                null,
                {
                  nameAr: "سلسلة",
                  purpose: "غرض",
                  questionnaireFamilyId: randomUUID(),
                },
                randomUUID(),
              ),
            ),
          ),
          "VALIDATION_FAILED",
          "an unknown questionnaire lineage cannot anchor a series",
        );
        const created = await withStaff(staff, (tx) =>
          saveSeries(
            tx,
            ids.orgA,
            null,
            null,
            {
              nameAr: "سلسلة سنوية",
              nameEn: "Annual series",
              purpose: "قياس دوري",
              questionnaireFamilyId: family,
            },
            randomUUID(),
          ),
        );
        series = created.id as string;
        assert.equal(created.revision, "1");

        // A draft version can never anchor a round.
        const draftVersion = (
          await operator.query(
            "insert into instrument.questionnaire_version(scope_id,questionnaire_id,version_number,metadata) select scope_id,questionnaire_id,99,metadata from instrument.questionnaire_version where id=$1 returning id",
            [BUILTIN_VERSION],
          )
        ).rows[0].id as string;
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              saveRound(
                tx,
                ids.orgA,
                null,
                null,
                {
                  seriesId: series,
                  label: "غير منشور",
                  periodStart: "2026-01-01",
                  questionnaireVersionId: draftVersion,
                  populationDefinition: { schemaVersion: 1 },
                },
                randomUUID(),
              ),
            ),
          ),
          "NOT_FOUND",
        );
        round = await newRound("الجولة الأولى");
        const stored = await withStaff(staff, (tx) =>
          sql<{
            questionnaire_version_id: string;
            state: string;
          }>`select questionnaire_version_id,state from core.assessment_round where id=${round}::uuid`.execute(
            tx,
          ),
        );
        assert.equal(stored.rows[0].questionnaire_version_id, BUILTIN_VERSION);
        assert.equal(stored.rows[0].state, "DRAFT");
      },
    );

    await t.test(
      "campaign creation pins exactly the round version, one campaign per round, and validates timing",
      async () => {
        const otherVersion = "44000000-0000-4000-9000-000000000002";
        assert.equal(
          await failure(() =>
            draftCampaign({ questionnaireVersionId: otherVersion }),
          ),
          "VALIDATION_FAILED",
          "a campaign may not pin a version other than its round's",
        );
        // An end before the start is rejected before the request is built.
        assert.throws(() =>
          campaignInput.parse({
            roundId: round,
            questionnaireVersionId: BUILTIN_VERSION,
            target: { mode: "SINGLE", participantId: people.p1 },
            startsAt: hourFrom(3600_000),
            endsAt: hourFrom(1800_000),
            timezone: "Asia/Riyadh",
          }),
        );
        assert.throws(() =>
          campaignInput.parse({
            roundId: round,
            questionnaireVersionId: BUILTIN_VERSION,
            target: { mode: "SINGLE", participantId: people.p1 },
            startsAt: hourFrom(3600_000),
            timezone: "Not/AZone",
          }),
        );
        assert.throws(
          () =>
            campaignInput.parse({
              roundId: round,
              questionnaireVersionId: BUILTIN_VERSION,
              target: {
                mode: "SINGLE",
                participantId: people.p1,
                participantIds: [people.p2],
              },
              startsAt: hourFrom(3600_000),
              timezone: "Asia/Riyadh",
            }),
          /./,
          "a payload mixing target modes is rejected",
        );
        campaign = (await draftCampaign()) as unknown as Campaign;
        assert.equal(campaign.state, "DRAFT");
        assert.equal(campaign.threshold, 5);
        assert.equal(campaign.roster_frozen_at, null);
        // Exactly one campaign per round.
        assert.equal(await failure(() => draftCampaign()), "STATE_CONFLICT");
      },
    );

    await t.test(
      "target resolution deduplicates and refuses foreign, archived or unknown people",
      async () => {
        const spare = await newRound("جولة الأهداف");
        const attempt = (target: unknown) =>
          failure(() =>
            withStaff(staff, (tx) =>
              saveCampaign(
                tx,
                ids.orgA,
                null,
                null,
                campaignInput.parse({
                  roundId: spare,
                  questionnaireVersionId: BUILTIN_VERSION,
                  target,
                  startsAt: hourFrom(3600_000),
                  timezone: "Asia/Riyadh",
                }),
                randomUUID(),
              ),
            ),
          );
        assert.equal(
          await attempt({
            mode: "SELECTED",
            participantIds: [people.p1, people.foreign],
          }),
          "VALIDATION_FAILED",
          "another organization's participant is never silently dropped",
        );
        assert.equal(
          await attempt({
            mode: "SELECTED",
            participantIds: [people.p1, people.archived],
          }),
          "VALIDATION_FAILED",
        );
        assert.equal(
          await attempt({ mode: "SELECTED", participantIds: [randomUUID()] }),
          "VALIDATION_FAILED",
        );
        assert.equal(
          await attempt({ mode: "DEPARTMENT", departmentId: randomUUID() }),
          "VALIDATION_FAILED",
        );
        // Duplicates in the request collapse to one person, not one invitation each.
        assert.equal(
          await attempt({
            mode: "SELECTED",
            participantIds: [people.p1, people.p1, people.p2],
          }),
          "NO_ERROR",
        );
        const review = (await withStaff(staff, (tx) =>
          sql<{
            id: string;
          }>`select id from core.campaign where round_id=${spare}::uuid`.execute(
            tx,
          ),
        )) as { rows: { id: string }[] };
        const preview = (await withStaff(staff, (tx) =>
          launchReview(tx, ids.orgA, review.rows[0].id),
        )) as { invited: number; reportEligible: boolean };
        assert.equal(preview.invited, 2, "a duplicated identifier counts once");
        assert.equal(preview.reportEligible, false);
      },
    );

    await t.test(
      "launch freezes roster, groups and manifest; department targeting resolves once",
      async () => {
        const deptRound = await newRound("جولة قسم");
        const deptCampaign = (await withStaff(staff, (tx) =>
          saveCampaign(
            tx,
            ids.orgA,
            null,
            null,
            campaignInput.parse({
              roundId: deptRound,
              questionnaireVersionId: BUILTIN_VERSION,
              target: { mode: "DEPARTMENT", departmentId: dept.d1 },
              startsAt: hourFrom(-1000),
              timezone: "Asia/Riyadh",
            }),
            randomUUID(),
          ),
        )) as unknown as Campaign;
        const launched = (await withStaff(staff, (tx) =>
          launchCampaign(
            tx,
            ids.orgA,
            deptCampaign.id,
            deptCampaign.revision,
            randomUUID(),
          ),
        )) as unknown as Campaign & {
          reportGroups: { kind: string; department_id: string | null }[];
        };
        // Start instant already passed, so launch opens immediately.
        assert.equal(launched.state, "OPEN");
        assert.equal(
          launched.frozen_invited_count,
          2,
          "the archived member of the department is excluded",
        );
        assert.deepEqual(
          launched.reportGroups.map((g) => g.kind).sort(),
          ["COMPANY", "DEPARTMENT"],
          "no OTHER group exists when every target has a department",
        );
        const manifest = launched.frozen_manifest as Record<string, unknown>;
        assert.equal(manifest.versionId, BUILTIN_VERSION);
        assert.equal(
          (manifest.policy as { threshold: number }).threshold,
          launched.threshold,
        );
        assert.equal(
          (manifest.policy as { segmentation: string }).segmentation,
          "FLAT_DEPARTMENT",
        );
        assert.equal(typeof manifest.instrumentHash, "string");
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              launchCampaign(
                tx,
                ids.orgA,
                deptCampaign.id,
                launched.revision,
                randomUUID(),
              ),
            ),
          ),
          "STATE_CONFLICT",
          "a launched campaign cannot be launched again",
        );
        // The round moved to collection at launch.
        const roundState = await withStaff(staff, (tx) =>
          sql<{
            state: string;
          }>`select state from core.assessment_round where id=${deptRound}::uuid`.execute(
            tx,
          ),
        );
        assert.equal(roundState.rows[0].state, "COLLECTING");

        // A later directory change must not alter the frozen roster.
        const late = randomUUID();
        await operator.query(
          "insert into core.participant(id,organization_id,private_reference,display_name,department_id) values($1,$2,'A-LATE','منضم لاحقًا',$3)",
          [late, ids.orgA, dept.d1],
        );
        await operator.query(
          "update core.participant set status='ARCHIVED' where id=$1",
          [people.p2],
        );
        const after = await withStaff(staff, (tx) =>
          participation(tx, ids.orgA, deptCampaign.id),
        );
        assert.equal(after.totals.invited, 2);
        assert.equal(
          after.items.some((i) => i.participantId === late),
          false,
          "a person added after launch never joins the frozen roster",
        );
        assert.equal(
          after.items.some((i) => i.participantId === people.p2),
          true,
          "archiving someone later does not remove their invitation",
        );
        assert.equal(
          await failure(async () => {
            await operator.query(
              "update core.campaign_roster set report_group_id=report_group_id, participant_id=$2 where campaign_id=$1",
              [deptCampaign.id, people.p3],
            );
          }),
          "STATE_CONFLICT",
          "frozen roster membership is immutable even for the operator role",
        );
        assert.equal(
          await failure(async () => {
            await operator.query(
              "update core.campaign set frozen_invited_count=99 where id=$1",
              [deptCampaign.id],
            );
          }),
          "STATE_CONFLICT",
        );
        await operator.query(
          "update core.participant set status='ACTIVE' where id=$1",
          [people.p2],
        );
      },
    );

    await t.test(
      "a single-person campaign is reported ineligible for any release",
      async () => {
        const soloRound = await newRound("جولة فردية");
        const solo = (await withStaff(staff, (tx) =>
          saveCampaign(
            tx,
            ids.orgA,
            null,
            null,
            campaignInput.parse({
              roundId: soloRound,
              questionnaireVersionId: BUILTIN_VERSION,
              target: { mode: "SINGLE", participantId: people.p3 },
              startsAt: hourFrom(-1000),
              timezone: "Asia/Riyadh",
            }),
            randomUUID(),
          ),
        )) as unknown as Campaign;
        const review = (await withStaff(staff, (tx) =>
          launchReview(tx, ids.orgA, solo.id),
        )) as {
          invited: number;
          reportEligible: boolean;
          singlePerson: boolean;
          threshold: number;
        };
        assert.equal(review.invited, 1);
        assert.equal(review.singlePerson, true);
        assert.equal(
          review.reportEligible,
          false,
          "one contributor can never reach the five-contributor threshold",
        );
        assert.equal(review.threshold, 5);
        const launched = (await withStaff(staff, (tx) =>
          launchCampaign(tx, ids.orgA, solo.id, solo.revision, randomUUID()),
        )) as unknown as Campaign;
        assert.equal(launched.frozen_invited_count, 1);
        const post = (await withStaff(staff, (tx) =>
          launchReview(tx, ids.orgA, solo.id),
        )) as { reportEligible: boolean; frozen: boolean };
        assert.equal(post.frozen, true);
        assert.equal(post.reportEligible, false);
      },
    );

    let openCampaign: Campaign, invitations: { invitationId: string }[];
    await t.test(
      "issuing reveals a link exactly once; retries and stale generations never re-reveal it",
      async () => {
        const r = await newRound("جولة الروابط");
        const created = (await withStaff(staff, (tx) =>
          saveCampaign(
            tx,
            ids.orgA,
            null,
            null,
            campaignInput.parse({
              roundId: r,
              questionnaireVersionId: BUILTIN_VERSION,
              target: {
                mode: "SELECTED",
                participantIds: [people.p1, people.p2, people.p3, people.p4],
              },
              startsAt: hourFrom(-1000),
              timezone: "Asia/Riyadh",
            }),
            randomUUID(),
          ),
        )) as unknown as Campaign;
        openCampaign = (await withStaff(staff, (tx) =>
          launchCampaign(tx, ids.orgA, created.id, created.revision, randomUUID()),
        )) as unknown as Campaign & {
          reportGroups: { kind: string }[];
        };
        assert.equal(openCampaign.state, "OPEN");
        assert.deepEqual(
          (openCampaign as unknown as { reportGroups: { kind: string }[] })
            .reportGroups.map((g) => g.kind)
            .sort(),
          ["COMPANY", "DEPARTMENT", "DEPARTMENT", "OTHER"],
          "the person without a department lands in OTHER, not an invented group",
        );
        const list = await withStaff(staff, (tx) =>
          participation(tx, ids.orgA, openCampaign.id),
        );
        invitations = list.items;
        assert.equal(list.totals.invited, 4);
        assert.equal(list.items.every((i) => !i.issued), true);
        assert.equal(list.items.every((i) => i.generation === 0), true);
        assert.equal(
          new Set(list.items.map((i) => i.displayReference)).size,
          4,
          "display references are unique and separate from any credential",
        );

        const first = (await withStaff(staff, (tx) =>
          invitationAction(
            tx,
            ids.orgA,
            openCampaign.id,
            invitations[0].invitationId,
            "ISSUE",
            { expectedGeneration: 0 },
            randomUUID(),
          ),
        )) as IssuedLink;
        assert.equal(first.generation, 1);
        assert.match(first.url, /^http:\/\/localhost:3001\/s#[A-Za-z0-9_-]{43}$/);
        const token = first.url.split("#")[1];
        // The credential is not recoverable from anything that was persisted.
        const stored = await operator.query(
          "select token_digest,digest_key_version,issued_at from core.invitation where id=$1",
          [invitations[0].invitationId],
        );
        assert.equal(stored.rows[0].digest_key_version, "test-v1");
        assert.deepEqual(
          Buffer.from(stored.rows[0].token_digest),
          tokenDigest(token),
        );
        assert.equal(
          stored.rows[0].token_digest.includes(Buffer.from(token, "utf8")),
          false,
        );
        const receipts = await operator.query(
          "select request_digest from access.staff_mutation",
        );
        assert.equal(
          receipts.rows.some((r: { request_digest: Buffer }) =>
            r.request_digest.includes(Buffer.from(token, "utf8")),
          ),
          false,
          "no idempotency receipt contains the raw credential",
        );

        // Re-issuing at the old generation is a conflict, not a second reveal.
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              invitationAction(
                tx,
                ids.orgA,
                openCampaign.id,
                invitations[0].invitationId,
                "ISSUE",
                { expectedGeneration: 0 },
                randomUUID(),
              ),
            ),
          ),
          "TOKEN_ALREADY_ISSUED",
        );
        // A replayed idempotency key returns a conflict, never old plaintext.
        const key = randomUUID();
        const issuedSecond = (await withStaff(staff, (tx) =>
          invitationAction(
            tx,
            ids.orgA,
            openCampaign.id,
            invitations[1].invitationId,
            "ISSUE",
            { expectedGeneration: 0 },
            key,
          ),
        )) as IssuedLink;
        assert.equal(issuedSecond.generation, 1);
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              invitationAction(
                tx,
                ids.orgA,
                openCampaign.id,
                invitations[1].invitationId,
                "ISSUE",
                { expectedGeneration: 0 },
                key,
              ),
            ),
          ),
          "TOKEN_ALREADY_ISSUED",
        );
      },
    );

    await t.test(
      "rotation and revocation invalidate live sessions and the previous link",
      async () => {
        const target = invitations[2].invitationId;
        const issued = (await withStaff(staff, (tx) =>
          invitationAction(
            tx,
            ids.orgA,
            openCampaign.id,
            target,
            "ISSUE",
            { expectedGeneration: 0 },
            randomUUID(),
          ),
        )) as IssuedLink;
        const oldToken = issued.url.split("#")[1];
        await operator.query("SET ROLE orgfit_core_owner");
        const opened = await exchange(operator, oldToken);
        assert.equal(opened.context.access, "OPEN");
        assert.equal(typeof opened.session, "string");
        assert.equal(
          (opened.context as { participantId?: string }).participantId,
          undefined,
          "the respondent context never carries an identity",
        );
        // Opening does not consume the invitation.
        assert.equal(
          (
            await operator.query(
              "select status from core.invitation where id=$1",
              [target],
            )
          ).rows[0].status,
          "READY",
        );

        const rotated = (await withStaff(staff, (tx) =>
          invitationAction(
            tx,
            ids.orgA,
            openCampaign.id,
            target,
            "ROTATE",
            { expectedGeneration: 1, reason: "فقد الرابط" },
            randomUUID(),
          ),
        )) as IssuedLink;
        assert.equal(rotated.generation, 2);
        assert.notEqual(rotated.url, issued.url);
        assert.equal(
          (await exchange(operator, oldToken)).context.access,
          "UNAVAILABLE",
          "the rotated-away link is generically unusable",
        );
        assert.equal(
          (await status(operator, opened.session!)).access,
          "SESSION_EXPIRED",
          "rotation invalidates the live session, not only future links",
        );
        const newToken = rotated.url.split("#")[1];
        const reopened = await exchange(operator, newToken);
        assert.equal(reopened.context.access, "OPEN");

        const revoked = await withStaff(staff, (tx) =>
          invitationAction(
            tx,
            ids.orgA,
            openCampaign.id,
            target,
            "REVOKE",
            { expectedGeneration: 2, reason: "غادر المنظمة" },
            randomUUID(),
          ),
        );
        assert.equal((revoked as { status: string }).status, "REVOKED");
        assert.equal(
          (await exchange(operator, newToken)).context.access,
          "UNAVAILABLE",
        );
        assert.equal(
          (await status(operator, reopened.session!)).access,
          "SESSION_EXPIRED",
        );
        // Revocation destroys the stored credential rather than flagging it.
        assert.equal(
          (
            await operator.query(
              "select token_digest,digest_key_version from core.invitation where id=$1",
              [target],
            )
          ).rows[0].token_digest,
          null,
        );
        assert.equal(
          (
            await operator.query(
              "select eligibility from core.campaign_roster where invitation_id=$1",
              [target],
            )
          ).rows[0].eligibility,
          "REVOKED",
        );
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              invitationAction(
                tx,
                ids.orgA,
                openCampaign.id,
                target,
                "ROTATE",
                { expectedGeneration: 2, reason: "محاولة" },
                randomUUID(),
              ),
            ),
          ),
          "STATE_CONFLICT",
          "a revoked invitation is terminal",
        );
        // Unknown and malformed links are indistinguishable from each other.
        assert.equal(
          (await exchange(operator, "z".repeat(43))).context.access,
          "UNAVAILABLE",
        );
        assert.equal((await exchange(operator, "short")).context.access, "UNAVAILABLE");
        assert.equal(
          (await status(operator, "y".repeat(43))).access,
          "SESSION_EXPIRED",
        );
      },
    );

    await t.test(
      "a completed invitation cannot be revoked or rotated to remove a response",
      async () => {
        const target = invitations[3].invitationId;
        await withStaff(staff, (tx) =>
          invitationAction(
            tx,
            ids.orgA,
            openCampaign.id,
            target,
            "ISSUE",
            { expectedGeneration: 0 },
            randomUUID(),
          ),
        );
        // Phase 07 owns the acceptance transaction; this simulates its outcome.
        await operator.query(
          "update core.invitation set status='COMPLETED' where id=$1",
          [target],
        );
        for (const [action, args] of [
          ["REVOKE", { expectedGeneration: 1, reason: "محاولة" }],
          ["ROTATE", { expectedGeneration: 1, reason: "محاولة" }],
        ] as const)
          assert.equal(
            await failure(() =>
              withStaff(staff, (tx) =>
                invitationAction(
                  tx,
                  ids.orgA,
                  openCampaign.id,
                  target,
                  action,
                  args,
                  randomUUID(),
                ),
              ),
            ),
            "STATE_CONFLICT",
          );
        assert.equal(
          await failure(async () => {
            await operator.query(
              "update core.invitation set status='READY' where id=$1",
              [target],
            );
          }),
          "STATE_CONFLICT",
          "completion is terminal even for the operator role",
        );
      },
    );

    await t.test("participation lists and denominators", async () => {
      const list = await withStaff(staff, (tx) =>
        participation(tx, ids.orgA, openCampaign.id),
      );
      assert.equal(list.totals.invited, 4);
      assert.equal(list.totals.completed, 1);
      assert.equal(list.totals.revoked, 1);
      assert.equal(list.totals.outstanding, 2);
      assert.equal(list.totals.eligible, 3, "eligible excludes revoked");
      assert.equal(Number(list.totals.rate).toFixed(4), (1 / 3).toFixed(4));
      assert.deepEqual(
        [...new Set(list.items.map((i) => i.status))].sort(),
        ["COMPLETED", "READY", "REVOKED"],
      );
      // The projection carries no answer, response identifier or score.
      for (const item of list.items)
        assert.deepEqual(Object.keys(item).sort(), [
          "displayName",
          "displayReference",
          "generation",
          "invitationId",
          "issued",
          "participantId",
          "reportGroupId",
          "status",
        ]);
      // Staff SQL may not read a token digest at all.
      assert.match(
        await failure(() =>
          withStaff(staff, (tx) =>
            sql`select token_digest from core.invitation limit 1`.execute(tx),
          ),
        ),
        /permission denied/i,
      );
      // Another organization's campaign is not visible.
      assert.equal(
        await failure(() =>
          withStaff(staff, (tx) =>
            participation(tx, ids.orgB, openCampaign.id),
          ),
        ),
        "NOT_FOUND",
      );
    });

    await t.test(
      "no-end campaigns stay open; the exact end boundary closes even with a stale scheduler",
      async () => {
        assert.equal(openCampaign.ends_at, null);
        assert.equal(
          (await withStaff(staff, (tx) => getCampaign(tx, ids.orgA, openCampaign.id)))
            .state,
          "OPEN",
          "a campaign with no end date remains open",
        );
        // Move the end boundary to exactly now, leaving the stored state stale.
        await operator.query(
          "update core.campaign set ends_at=clock_timestamp() where id=$1",
          [openCampaign.id],
        );
        assert.equal(
          (
            await operator.query(
              "select state from core.campaign where id=$1",
              [openCampaign.id],
            )
          ).rows[0].state,
          "OPEN",
          "the stored state is deliberately stale for this check",
        );
        const effective = await operator.query(
          "select core.effective_state(state,starts_at,ends_at) s from core.campaign where id=$1",
          [openCampaign.id],
        );
        assert.equal(
          effective.rows[0].s,
          "CLOSED",
          "the request-time boundary is authoritative at the exact instant",
        );
        const viewed = await withStaff(staff, (tx) =>
          getCampaign(tx, ids.orgA, openCampaign.id),
        );
        assert.equal(viewed.state, "CLOSED");
        assert.equal(viewed.close_kind, "END_DATE");
        // A still-valid session sees the closure without any scheduler running.
        const roundState = await operator.query(
          "select state from core.assessment_round where id=$1",
          [openCampaign.round_id],
        );
        assert.equal(roundState.rows[0].state, "PROCESSING");
        // No path reopens a closed campaign.
        for (const [action, args] of [
          ["END_DATE", { endsAt: hourFrom(3600_000) }],
          ["CLOSE", { reason: "مرة أخرى" }],
          ["CANCEL", { reason: "بعد الإغلاق" }],
        ] as const)
          assert.equal(
            await failure(() =>
              withStaff(staff, (tx) =>
                campaignTransition(
                  tx,
                  ids.orgA,
                  openCampaign.id,
                  viewed.revision,
                  action,
                  args,
                  randomUUID(),
                ),
              ),
            ),
            "STATE_CONFLICT",
          );
        assert.equal(
          await failure(async () => {
            await operator.query(
              "update core.campaign set state='OPEN' where id=$1",
              [openCampaign.id],
            );
          }),
          "STATE_CONFLICT",
          "closure is terminal even for the operator role",
        );
        // Issuing into a closed campaign is denied.
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              invitationAction(
                tx,
                ids.orgA,
                openCampaign.id,
                invitations[0].invitationId,
                "ROTATE",
                { expectedGeneration: 1, reason: "بعد الإغلاق" },
                randomUUID(),
              ),
            ),
          ),
          "STATE_CONFLICT",
        );
      },
    );

    await t.test(
      "scheduled campaigns open at the start instant and the durable scheduler only catches up",
      async () => {
        const r = await newRound("جولة مجدولة");
        const created = (await withStaff(staff, (tx) =>
          saveCampaign(
            tx,
            ids.orgA,
            null,
            null,
            campaignInput.parse({
              roundId: r,
              questionnaireVersionId: BUILTIN_VERSION,
              target: { mode: "DEPARTMENT", departmentId: dept.d1 },
              startsAt: hourFrom(START_DELAY_MS),
              endsAt: hourFrom(7200_000),
              timezone: "Asia/Riyadh",
            }),
            randomUUID(),
          ),
        )) as unknown as Campaign;
        const scheduled = (await withStaff(staff, (tx) =>
          launchCampaign(tx, ids.orgA, created.id, created.revision, randomUUID()),
        )) as unknown as Campaign;
        assert.equal(scheduled.state, "SCHEDULED");
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              campaignTransition(
                tx,
                ids.orgA,
                created.id,
                scheduled.revision,
                "CLOSE",
                { reason: "قبل الفتح" },
                randomUUID(),
              ),
            ),
          ),
          "STATE_CONFLICT",
          "a campaign that has not opened cannot be manually closed",
        );
        assert.equal(
          await normalizeCampaigns(fixture.url("orgfit_migrator")),
          0,
          "nothing is due before the start instant",
        );
        // Reach the start instant by waiting for it.
        await wait(START_DELAY_MS + 500);
        assert.equal(
          await normalizeCampaigns(fixture.url("orgfit_migrator")),
          1,
        );
        assert.equal(
          (
            await operator.query(
              "select state from core.campaign where id=$1",
              [created.id],
            )
          ).rows[0].state,
          "OPEN",
        );
        // End-date rules before closure.
        let current = await withStaff(staff, (tx) =>
          getCampaign(tx, ids.orgA, created.id),
        );
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              campaignTransition(
                tx,
                ids.orgA,
                created.id,
                current.revision,
                "END_DATE",
                { endsAt: hourFrom(-3600_000) },
                randomUUID(),
              ),
            ),
          ),
          "VALIDATION_FAILED",
          "an end date in the past can never be set",
        );
        const extended = (await withStaff(staff, (tx) =>
          campaignTransition(
            tx,
            ids.orgA,
            created.id,
            current.revision,
            "END_DATE",
            { endsAt: hourFrom(10_800_000) },
            randomUUID(),
          ),
        )) as unknown as Campaign;
        assert.notEqual(extended.ends_at, null);
        const audited = await operator.query(
          "select count(*)::int n from ops.audit_log where action='CAMPAIGN_END_DATE_CHANGED' and target_id=$1",
          [created.id],
        );
        assert.equal(audited.rows[0].n, 1, "end-date changes are audited");
        // Removing the end date entirely keeps the campaign open.
        current = await withStaff(staff, (tx) =>
          getCampaign(tx, ids.orgA, created.id),
        );
        const opened = (await withStaff(staff, (tx) =>
          campaignTransition(
            tx,
            ids.orgA,
            created.id,
            current.revision,
            "END_DATE",
            { endsAt: null },
            randomUUID(),
          ),
        )) as unknown as Campaign;
        assert.equal(opened.ends_at, null);
        assert.equal(opened.state, "OPEN");
        // Once the boundary has passed, extension cannot reopen collection.
        await operator.query(
          // The boundary must be in the past AND after starts_at, which a fixed
          // offset from the current instant cannot guarantee on a fast machine:
          // the scheduled start is only two seconds old by the time this runs.
          "update core.campaign set ends_at=starts_at+interval '1 millisecond' where id=$1",
          [created.id],
        );
        current = await withStaff(staff, (tx) =>
          getCampaign(tx, ids.orgA, created.id),
        );
        assert.equal(current.state, "CLOSED");
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              campaignTransition(
                tx,
                ids.orgA,
                created.id,
                current.revision,
                "END_DATE",
                { endsAt: hourFrom(3600_000) },
                randomUUID(),
              ),
            ),
          ),
          "STATE_CONFLICT",
        );
      },
    );

    await t.test(
      "manual close and cancellation are reasoned, terminal and revision checked",
      async () => {
        const r = await newRound("جولة الإغلاق");
        const created = (await withStaff(staff, (tx) =>
          saveCampaign(
            tx,
            ids.orgA,
            null,
            null,
            campaignInput.parse({
              roundId: r,
              questionnaireVersionId: BUILTIN_VERSION,
              target: { mode: "DEPARTMENT", departmentId: dept.d2 },
              startsAt: hourFrom(-1000),
              timezone: "Asia/Riyadh",
            }),
            randomUUID(),
          ),
        )) as unknown as Campaign;
        const live = (await withStaff(staff, (tx) =>
          launchCampaign(tx, ids.orgA, created.id, created.revision, randomUUID()),
        )) as unknown as Campaign;
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              campaignTransition(
                tx,
                ids.orgA,
                created.id,
                "999",
                "CLOSE",
                { reason: "خطأ" },
                randomUUID(),
              ),
            ),
          ),
          "REVISION_CONFLICT",
        );
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              campaignTransition(
                tx,
                ids.orgA,
                created.id,
                live.revision,
                "CLOSE",
                { reason: "  " },
                randomUUID(),
              ),
            ),
          ),
          "VALIDATION_FAILED",
          "a manual close must record a reason",
        );
        const closed = (await withStaff(staff, (tx) =>
          campaignTransition(
            tx,
            ids.orgA,
            created.id,
            live.revision,
            "CLOSE",
            { reason: "اكتمل الجمع" },
            randomUUID(),
          ),
        )) as unknown as Campaign;
        assert.equal(closed.state, "CLOSED");
        assert.equal(closed.close_kind, "MANUAL");
        assert.equal(closed.close_reason, "اكتمل الجمع");
        const archived = (await withStaff(staff, (tx) =>
          campaignTransition(
            tx,
            ids.orgA,
            created.id,
            closed.revision,
            "ARCHIVE",
            {},
            randomUUID(),
          ),
        )) as unknown as Campaign;
        assert.equal(archived.archived, true);
        assert.equal(
          archived.state,
          "CLOSED",
          "archiving is a visibility flag, not a state change",
        );

        // Cancellation from DRAFT keeps the round consistent.
        const cancelRound = await newRound("جولة ملغاة");
        const draft = (await withStaff(staff, (tx) =>
          saveCampaign(
            tx,
            ids.orgA,
            null,
            null,
            campaignInput.parse({
              roundId: cancelRound,
              questionnaireVersionId: BUILTIN_VERSION,
              target: { mode: "SINGLE", participantId: people.p4 },
              startsAt: hourFrom(3600_000),
              timezone: "Asia/Riyadh",
            }),
            randomUUID(),
          ),
        )) as unknown as Campaign;
        const cancelled = (await withStaff(staff, (tx) =>
          campaignTransition(
            tx,
            ids.orgA,
            draft.id,
            draft.revision,
            "CANCEL",
            { reason: "تغير النطاق" },
            randomUUID(),
          ),
        )) as unknown as Campaign;
        assert.equal(cancelled.state, "CANCELLED");
        assert.equal(
          (
            await operator.query(
              "select state from core.assessment_round where id=$1",
              [cancelRound],
            )
          ).rows[0].state,
          "CANCELLED",
        );
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              launchCampaign(
                tx,
                ids.orgA,
                draft.id,
                cancelled.revision,
                randomUUID(),
              ),
            ),
          ),
          "STATE_CONFLICT",
        );
      },
    );

    await t.test(
      "manual link export issues atomically, refuses partial plans and expires",
      async () => {
        const r = await newRound("جولة التصدير");
        const created = (await withStaff(staff, (tx) =>
          saveCampaign(
            tx,
            ids.orgA,
            null,
            null,
            campaignInput.parse({
              roundId: r,
              questionnaireVersionId: BUILTIN_VERSION,
              target: {
                mode: "SELECTED",
                participantIds: [people.p1, people.p3, people.p4],
              },
              startsAt: hourFrom(-1000),
              timezone: "Asia/Riyadh",
            }),
            randomUUID(),
          ),
        )) as unknown as Campaign;
        const live = (await withStaff(staff, (tx) =>
          launchCampaign(tx, ids.orgA, created.id, created.revision, randomUUID()),
        )) as unknown as Campaign;
        const list = await withStaff(staff, (tx) =>
          participation(tx, ids.orgA, live.id),
        );
        const all = list.items.map((i) => i.invitationId);
        // One wrong expected generation aborts the entire plan.
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              createLinkExport(
                tx,
                ids.orgA,
                live.id,
                linkExportInput.parse({
                  invitationIds: all,
                  expectedGenerations: [0, 0, 3],
                  confirmRotation: false,
                }),
                randomUUID(),
              ),
            ),
          ),
          "TOKEN_ALREADY_ISSUED",
        );
        assert.equal(
          (
            await operator.query(
              "select count(*)::int n from core.invitation where campaign_id=$1 and token_generation>0",
              [live.id],
            )
          ).rows[0].n,
          0,
          "an aborted plan issues nothing at all",
        );
        // An invitation from another campaign aborts the plan too.
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              createLinkExport(
                tx,
                ids.orgA,
                live.id,
                linkExportInput.parse({
                  invitationIds: [all[0], invitations[0].invitationId],
                  expectedGenerations: [0, 1],
                  confirmRotation: true,
                }),
                randomUUID(),
              ),
            ),
          ),
          "NOT_FOUND",
        );
        const receipt = await withStaff(staff, (tx) =>
          createLinkExport(
            tx,
            ids.orgA,
            live.id,
            linkExportInput.parse({
              invitationIds: all,
              expectedGenerations: [0, 0, 0],
              confirmRotation: false,
            }),
            randomUUID(),
          ),
        );
        assert.equal(receipt.itemCount, 3);
        assert.equal(receipt.rotatedCount, 0);
        assert.equal(receipt.expiresInHours, 24);
        const bytes = await getExport(ids.orgA, receipt.exportId);
        const csv = bytes.toString("utf8");
        assert.equal(csv.split("\r\n").filter(Boolean).length, 4);
        const exported = csv
          .split("\r\n")
          .slice(1)
          .filter(Boolean)
          .map((line) => line.split(",")[2].replaceAll('"', ""));
        // Every exported link is a working credential for its own invitation.
        const opened = await exchange(operator, exported[0].split("#")[1]);
        assert.equal(opened.context.access, "OPEN");
        // Re-issuing already-issued invitations requires explicit confirmation.
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              createLinkExport(
                tx,
                ids.orgA,
                live.id,
                linkExportInput.parse({
                  invitationIds: all,
                  expectedGenerations: [1, 1, 1],
                  confirmRotation: false,
                }),
                randomUUID(),
              ),
            ),
          ),
          "PRECONDITION_REQUIRED",
        );
        const rotation = await withStaff(staff, (tx) =>
          createLinkExport(
            tx,
            ids.orgA,
            live.id,
            linkExportInput.parse({
              invitationIds: all,
              expectedGenerations: [1, 1, 1],
              confirmRotation: true,
            }),
            randomUUID(),
          ),
        );
        assert.equal(rotation.rotatedCount, 3);
        assert.equal(
          (await exchange(operator, exported[0].split("#")[1])).context.access,
          "UNAVAILABLE",
          "the rotating export invalidated every previous link",
        );
        assert.equal(
          (await status(operator, opened.session!)).access,
          "SESSION_EXPIRED",
        );
        // Access control and expiry on the stored file.
        assert.equal(
          await failure(() =>
            withStaff(admin, (tx) =>
              linkExportKey(tx, ids.orgB, receipt.exportId),
            ),
          ),
          "NOT_FOUND",
          "an export is scoped to its own organization",
        );
        assert.equal(
          typeof (await withStaff(staff, (tx) =>
            linkExportKey(tx, ids.orgA, receipt.exportId),
          )),
          "string",
        );
        await operator.query(
          "update ops.private_export set expires_at=clock_timestamp()-interval '1 minute' where id=$1",
          [receipt.exportId],
        );
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              linkExportKey(tx, ids.orgA, receipt.exportId),
            ),
          ),
          "IMPORT_EXPIRED",
        );
        assert.equal(
          (
            await operator.query(
              "select count(*)::int n from ops.audit_log where action='LINK_EXPORT_DOWNLOADED'",
            )
          ).rows[0].n >= 1,
          true,
        );
      },
    );

    await t.test("gateway status derives access without leaking state", async () => {
      const r = await newRound("جولة البوابة");
      const created = (await withStaff(staff, (tx) =>
        saveCampaign(
          tx,
          ids.orgA,
          null,
          null,
          campaignInput.parse({
            roundId: r,
            questionnaireVersionId: BUILTIN_VERSION,
            target: { mode: "SINGLE", participantId: people.p1 },
            startsAt: hourFrom(START_DELAY_MS),
            timezone: "Asia/Riyadh",
          }),
          randomUUID(),
        ),
      )) as unknown as Campaign;
      const scheduled = (await withStaff(staff, (tx) =>
        launchCampaign(tx, ids.orgA, created.id, created.revision, randomUUID()),
      )) as unknown as Campaign;
      const list = await withStaff(staff, (tx) =>
        participation(tx, ids.orgA, created.id),
      );
      const issued = (await withStaff(staff, (tx) =>
        invitationAction(
          tx,
          ids.orgA,
          created.id,
          list.items[0].invitationId,
          "ISSUE",
          { expectedGeneration: 0 },
          randomUUID(),
        ),
      )) as IssuedLink;
      const token = issued.url.split("#")[1];
      const before = await exchange(operator, token);
      assert.equal(before.context.access, "NOT_YET_OPEN");
      assert.equal(before.context.campaignId, created.id);
      assert.equal(before.context.versionId, BUILTIN_VERSION);
      assert.deepEqual(before.context.locales, ["ar"]);
      assert.equal(
        Object.keys(before.context).includes("displayName"),
        false,
        "no respondent identity is ever returned",
      );
      await wait(START_DELAY_MS + 500);
      assert.equal((await status(operator, before.session!)).access, "OPEN");
      // Completion outranks a later closure.
      await operator.query(
        "update core.invitation set status='COMPLETED' where id=$1",
        [list.items[0].invitationId],
      );
      await operator.query(
        "update core.campaign set ends_at=clock_timestamp() where id=$1",
        [created.id],
      );
      assert.equal((await status(operator, before.session!)).access, "ACCEPTED");
      // A cancelled campaign is generically unavailable, not "cancelled".
      const cancelRound = await newRound("جولة إلغاء البوابة");
      const other = (await withStaff(staff, (tx) =>
        saveCampaign(
          tx,
          ids.orgA,
          null,
          null,
          campaignInput.parse({
            roundId: cancelRound,
            questionnaireVersionId: BUILTIN_VERSION,
            target: { mode: "SINGLE", participantId: people.p3 },
            startsAt: hourFrom(-1000),
            timezone: "Asia/Riyadh",
          }),
          randomUUID(),
        ),
      )) as unknown as Campaign;
      const otherLive = (await withStaff(staff, (tx) =>
        launchCampaign(tx, ids.orgA, other.id, other.revision, randomUUID()),
      )) as unknown as Campaign;
      const otherList = await withStaff(staff, (tx) =>
        participation(tx, ids.orgA, other.id),
      );
      const otherLink = (await withStaff(staff, (tx) =>
        invitationAction(
          tx,
          ids.orgA,
          other.id,
          otherList.items[0].invitationId,
          "ISSUE",
          { expectedGeneration: 0 },
          randomUUID(),
        ),
      )) as IssuedLink;
      const otherSession = await exchange(operator, otherLink.url.split("#")[1]);
      assert.equal(otherSession.context.access, "OPEN");
      await withStaff(staff, (tx) =>
        campaignTransition(
          tx,
          ids.orgA,
          other.id,
          otherLive.revision,
          "CANCEL",
          { reason: "أُلغيت" },
          randomUUID(),
        ),
      );
      assert.equal(
        (await status(operator, otherSession.session!)).access,
        "UNAVAILABLE",
      );
      assert.equal(scheduled.state, "SCHEDULED");
    });

    await t.test("exported CSV neutralizes spreadsheet formulas", () => {
      const csv = linkExportCsv([
        {
          invitationId: randomUUID(),
          displayReference: "=cmd|calc",
          generation: 1,
          url: invitationUrl("a".repeat(43)),
        },
      ]);
      assert.match(csv, /"'=cmd\|calc"/);
      assert.equal(csv.includes('\n"=cmd'), false);
    });

    await t.test(
      "campaign detail stays inside its own organization",
      async () => {
        assert.equal(
          await failure(() =>
            withStaff(staff, (tx) =>
              campaignDetail(tx, ids.orgB, openCampaign.id),
            ),
          ),
          "NOT_FOUND",
        );
      },
    );
  } finally {
    await Promise.all([auth.end(), operator.end(), runtime.end(), upgrade.end()]);
    await cleanLocalExports(Date.now() + 86_400_000 * 2).catch(() => 0);
  }
});
