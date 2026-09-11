import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { setupDatabase } from "./database";
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
  participation,
} from "../src/campaigns";
import { campaignInput } from "../src/campaign-input";
import { saveInstrument } from "../src/instruments";
import {
  type Instrument,
  blankInstrument,
  newIdentity,
  newQuestion,
  tr,
} from "../src/instrument-input";
import { configureGateway } from "../src/gateway-db";
import {
  generateCustodianKeypair,
  setCustodianSecret,
} from "../src/key-custody";

export const BUILTIN_VERSION = "44000000-0000-4000-9000-000000000001";
export const BUILTIN_QUESTIONNAIRE = "44000000-0000-4000-8000-000000000001";

export const failure = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (e) {
    return e instanceof AppError ? e.code : (e as Error).message;
  }
  return "NO_ERROR";
};
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Fixture = Awaited<ReturnType<typeof respondentFixture>>;

// One shared synthetic environment for the Phase 07 suites. It builds a real
// launched campaign with real invitation links, then hands back the staff,
// operator, gateway and processor handles so each test can drive the actual
// components rather than a mock of them.
export async function respondentFixture(peopleCount = 6) {
  const fixture = await setupDatabase();
  const custodian = await generateCustodianKeypair();
  const custodyDirectory = await mkdtemp(join(tmpdir(), "orgfit-custody-"));

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
    CAMPAIGN_KEY_CUSTODY_DIRECTORY: custodyDirectory,
    CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY: custodian.publicKey,
  });
  delete process.env.MIGRATION_DATABASE_URL;
  delete process.env.CAMPAIGN_KEY_CUSTODY_SECRET_KEY;
  // Only the processor half of the harness is given the custodian secret. It is
  // never placed in process.env, so the staff configuration guard stays armed.
  setCustodianSecret(custodian.secretKey);
  configureGateway(fixture.url("orgfit_gateway"));

  const auth = new pg.Client({ connectionString: fixture.url("orgfit_auth") });
  const operator = new pg.Client({
    connectionString: fixture.url("orgfit_migrator"),
  });
  await Promise.all([auth.connect(), operator.connect()]);
  await operator.query("SET ROLE orgfit_core_owner");

  const session = async (subject: string) => {
    const token = secret();
    await auth.query("select access.issue_session($1,$2,$3)", [
      process.env.OIDC_ISSUER,
      subject,
      digest(token),
    ]);
    return token;
  };
  for (const capability of [
    "campaigns.manage",
    "participation.read",
    "participation.export",
    "results.read",
    "instruments.manage",
    // Phase 11. Granted here rather than by a later suite: a capability change
    // bumps the auth epoch and revokes the fixture session every helper uses.
    "reports.manage",
    // Phase 12, for the same reason.
    "visits.manage",
  ])
    await operator.query(
      "insert into access.staff_capability(staff_user_id,capability) values($1,$2) on conflict do nothing",
      [ids.staff, capability],
    );
  const staff = await session("staff");

  const departmentA = randomUUID(),
    departmentB = randomUUID();
  for (const [id, code, name] of [
    [departmentA, "ENG", "الهندسة"],
    [departmentB, "OPS", "العمليات"],
  ] as const)
    await operator.query(
      "insert into core.department(id,organization_id,code,name_ar) values($1,$2,$3,$4)",
      [id, ids.orgA, code, name],
    );
  const people: string[] = [];
  for (let i = 0; i < peopleCount; i++) {
    const id = randomUUID();
    people.push(id);
    await operator.query(
      "insert into core.participant(id,organization_id,private_reference,display_name,department_id) values($1,$2,$3,$4,$5)",
      [
        id,
        ids.orgA,
        `A-${i + 1}`,
        `مشارك ${i + 1}`,
        i % 2 === 0 ? departmentA : departmentB,
      ],
    );
  }

  // A purpose-built published instrument covering every collectable question
  // type, one scored dimension and an overall score. The seeded illustrative
  // templates are deliberately thin, and the tampering, typed-value and scoring
  // paths must be exercised against real options, matrix rows and validation
  // bounds rather than against two questions.
  const coverageVersion = await publishCoverageInstrument();
  const coverageFamily = (
    await operator.query(
      "select family_key from instrument.questionnaire where id=$1",
      [coverageVersion.questionnaire_id],
    )
  ).rows[0].family_key as string;
  async function publishCoverageInstrument() {
    // Every capability is granted BEFORE any session is issued: a capability
    // change bumps the auth epoch and revokes live staff sessions by design.
    const author = staff;
    const document = blankInstrument();
    document.locales = ["ar", "en"];
    document.title = tr("استبانة تغطية", "Coverage questionnaire");
    document.introduction = tr("مقدمة", "Introduction");
    document.privacyText = tr(
      "إشعار خصوصية تجريبي للاختبار فقط.",
      "Synthetic privacy notice for testing only.",
    );
    const dimension = {
      ...newIdentity(),
      name: tr("بعد", "Dimension"),
      description: tr("وصف", "Description"),
      mode: "AVERAGE" as const,
      coverage: "0.5",
      direction: "HIGH_GOOD" as const,
      denominator: null,
      bands: [
        {
          ...newIdentity(),
          lower: "0",
          upper: "50",
          label: tr("منخفض", "Low"),
          severity: "HIGH" as const,
          semantic: "RISK" as const,
        },
        {
          ...newIdentity(),
          lower: "50",
          upper: "100",
          label: tr("مرتفع", "High"),
          severity: "NONE" as const,
          semantic: "HEALTH" as const,
        },
      ],
    };
    document.dimensions = [dimension];
    const questions = (
      [
        "SHORT_TEXT",
        "LONG_TEXT",
        "MULTIPLE_CHOICE",
        "CHECKBOXES",
        "DROPDOWN",
        "YES_NO",
        "RATING_5",
        "RATING_10",
        "MATRIX",
        "NUMBER",
        "DATE",
        "CONTENT",
      ] as const
    ).map((type, index) => {
      const q = newQuestion(type);
      q.prompt = tr(`سؤال ${index + 1} (${type})`, `Question ${index + 1}`);
      q.help = tr("مساعدة", "Help");
      for (const option of [...q.options, ...q.columns])
        option.label = tr(`خيار ${option.score}`, `Option ${option.score}`);
      for (const row of q.rows) row.label = tr("صف", "Row");
      if (type === "NUMBER")
        q.validation = { min: "0", max: "10", precision: 0 };
      if (type === "DATE")
        q.validation = { minDate: "2026-01-01", maxDate: "2026-12-31" };
      if (type === "LONG_TEXT") q.required = false;
      // Two scored items give the dimension and the overall score real inputs.
      if (type === "RATING_5" || type === "RATING_10") {
        q.dimensionId = dimension.id;
        q.scoring = {
          enabled: true,
          reverse: false,
          weight: "1",
          mode: "VALUE",
        };
      }
      return q;
    });
    document.sections = [
      {
        ...newIdentity(),
        title: tr("القسم الأول", "First section"),
        content: tr("محتوى", "Content"),
        questions: questions.slice(0, 6),
      },
      {
        ...newIdentity(),
        title: tr("القسم الثاني", "Second section"),
        content: tr(),
        questions: questions.slice(6),
      },
    ];
    document.overall = {
      enabled: true,
      direction: "HIGH_GOOD",
      inputs: [{ dimensionId: dimension.id, weight: "1", invert: false }],
      bands: dimension.bands.map((b) => ({ ...b, ...newIdentity() })),
    };
    // Deterministic recommendation rules for the Phase 09 path. The thresholds
    // are deliberately unconditional so the end-to-end suite exercises firing,
    // exclusivity and department scope rather than a particular score; the
    // adversarial threshold cases live in the pure evaluator suite.
    const rule = (
      over: Instrument["recommendations"][number]["target"],
      overrides: Partial<Instrument["recommendations"][number]>,
    ): Instrument["recommendations"][number] => ({
      ...newIdentity(),
      target: over,
      groupScope: "COMPANY",
      condition: {
        mode: "ALL",
        clauses: [
          {
            mode: "ALL",
            comparisons: [
              { metric: over, operator: "GTE", value: "0", upper: null },
            ],
          },
        ],
      },
      priority: 100,
      dedupKey: "review",
      exclusivityGroup: null,
      title: tr("مراجعة", "Review"),
      body: tr(
        "النتيجة {score} ضمن {band}.",
        "The score is {score}, within {band}.",
      ),
      action: tr("راجع الممارسات", "Review practices"),
      rationale: tr(
        "مبني على {metric} لـ{group}.",
        "Based on {metric} for {group}.",
      ),
      enabled: true,
      ...overrides,
    });
    document.recommendations = [
      rule(
        { kind: "OVERALL" },
        {
          priority: 10,
          dedupKey: "overall-review",
          exclusivityGroup: "overall",
        },
      ),
      // Same exclusivity group and a weaker priority: this one must never be
      // published beside the rule above.
      rule(
        { kind: "OVERALL" },
        {
          priority: 20,
          dedupKey: "overall-alternate",
          exclusivityGroup: "overall",
        },
      ),
      rule(
        { kind: "DIMENSION", dimensionId: dimension.id },
        {
          priority: 30,
          dedupKey: "dimension-department",
          groupScope: "DEPARTMENT",
        },
      ),
      // Disabled configuration never reaches a release.
      rule(
        { kind: "OVERALL" },
        { priority: 5, dedupKey: "disabled-rule", enabled: false },
      ),
    ];
    const created = (await withStaff(author, (tx) =>
      saveInstrument(tx, {
        org: ids.orgA,
        action: "CREATE",
        document,
        idem: randomUUID(),
      }),
    )) as {
      id: string;
      questionnaire_id: string;
      revision: string;
      document: Instrument;
    };
    const published = (await withStaff(author, (tx) =>
      saveInstrument(tx, {
        org: ids.orgA,
        qid: created.questionnaire_id,
        vid: created.id,
        revision: created.revision,
        action: "PUBLISH",
        // Publication must carry the document: that is what produces the
        // content hash every later phase binds to.
        document: created.document,
        idem: randomUUID(),
      }),
    )) as { id: string; questionnaire_id: string };
    return published;
  }

  const series = (await withStaff(staff, (tx) =>
    saveSeries(
      tx,
      ids.orgA,
      null,
      null,
      {
        nameAr: "سلسلة",
        purpose: "قياس",
        questionnaireFamilyId: coverageFamily,
      },
      randomUUID(),
    ),
  )) as { id: string };

  async function launchedCampaign(
    participantIds: string[] = people,
    overrides: Record<string, unknown> = {},
  ) {
    const round = (await withStaff(staff, (tx) =>
      saveRound(
        tx,
        ids.orgA,
        null,
        null,
        {
          seriesId: series.id,
          label: `جولة ${randomUUID().slice(0, 8)}`,
          periodStart: "2026-01-01",
          questionnaireVersionId: coverageVersion.id,
          populationDefinition: { schemaVersion: 1 },
        },
        randomUUID(),
      ),
    )) as { id: string };
    const campaign = (await withStaff(staff, (tx) =>
      saveCampaign(
        tx,
        ids.orgA,
        null,
        null,
        campaignInput.parse({
          roundId: round.id,
          questionnaireVersionId: coverageVersion.id,
          target: { mode: "SELECTED", participantIds },
          startsAt: new Date(Date.now() - 1000).toISOString(),
          timezone: "Asia/Riyadh",
          ...overrides,
        }),
        randomUUID(),
      ),
    )) as { id: string; revision: string };
    await withStaff(staff, (tx) =>
      launchCampaign(
        tx,
        ids.orgA,
        campaign.id,
        campaign.revision,
        randomUUID(),
      ),
    );
    return { roundId: round.id, campaignId: campaign.id };
  }
  // Issue a real link for every invitation in the campaign, exactly as staff
  // would. The plaintext token exists only in this test process's memory.
  async function issueLinks(campaignId: string) {
    const list = (await withStaff(staff, (tx) =>
      participation(tx, ids.orgA, campaignId),
    )) as { items: { invitationId: string; generation: number }[] };
    const tokens: { invitationId: string; token: string }[] = [];
    for (const item of list.items) {
      const issued = (await withStaff(staff, (tx) =>
        invitationAction(
          tx,
          ids.orgA,
          campaignId,
          item.invitationId,
          "ISSUE",
          { expectedGeneration: item.generation },
          randomUUID(),
        ),
      )) as { url: string };
      tokens.push({
        invitationId: item.invitationId,
        token: issued.url.split("#")[1],
      });
    }
    return tokens;
  }
  async function closeCampaign(campaignId: string) {
    const current = (
      await operator.query("select revision from core.campaign where id=$1", [
        campaignId,
      ])
    ).rows[0].revision as string;
    await withStaff(staff, (tx) =>
      campaignTransition(
        tx,
        ids.orgA,
        campaignId,
        current,
        "CLOSE",
        { reason: "اكتمال الجمع" },
        randomUUID(),
      ),
    );
  }
  async function close() {
    configureGateway(undefined);
    setCustodianSecret(undefined);
    await auth.end();
    await operator.end();
  }
  return {
    fixture,
    operator,
    staff,
    session,
    orgA: ids.orgA,
    orgB: ids.orgB,
    people,
    departmentA,
    departmentB,
    seriesId: series.id,
    custodyDirectory,
    custodianSecret: custodian.secretKey,
    coverageVersionId: coverageVersion.id,
    launchedCampaign,
    issueLinks,
    closeCampaign,
    close,
  };
}
