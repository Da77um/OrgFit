import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { withStaff } from "../src/db";
import { ids } from "../scripts/seed";
import { visitRoute } from "../src/visits";
import { verifyAttachment, sniff } from "../src/attachment-scan";
import { deleteAttachment } from "../src/attachment-storage";
import {
  configureScanner,
  scannerPool,
  scannerReadiness,
  closeScannerPool,
  assertNoForeignCredentials,
} from "../src/scanner-db";
import { scanDueAttachments } from "../src/attachment-worker";
import { respondentFixture, failure } from "./respondent-fixture";

// ---------------------------------------------------------------------------
// Phase 12 against the real thing.
//
// Real visits in a real database, driven through the real staff route under a
// real staff session, with real bytes written to the real private store and a
// real scan performed by the real scanner credential.
//
// The properties under test are the ones this module can get wrong in a way
// that matters: a visit that reopens itself, a completed record that can be
// rewritten without saying so, a consultant who was disabled and is still being
// assigned work, a file from one organization reachable from another, and — the
// one that would matter most — a file that becomes downloadable without anything
// having read its bytes.
// ---------------------------------------------------------------------------

const AR_PURPOSE = "زيارة ميدانية لتقييم بيئة العمل في الفروع التشغيلية";
const AR_FINDINGS =
  "لوحظ أن فرق التشغيل تعمل بمعدل مناوبات مرتفع، وأن قنوات التصعيد غير موثقة" +
  " بشكل كافٍ لدى المشرفين الجدد في الفروع الثلاثة التي زُرناها.";

// --- sample files, built rather than fetched -------------------------------
const pdfBytes = () =>
  Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
    "latin1",
  );
const pngBytes = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 7),
  ]);
async function docxBytes(extra?: { name: string; content: string }) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file("word/document.xml", "<w:document><w:body/></w:document>");
  if (extra) zip.file(extra.name, extra.content);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}
const EICAR_BODY =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

test("Phase 12 — field visits, follow-ups and private attachments", async (t) => {
  const f = await respondentFixture(6);
  const storage = await mkdtemp(join(tmpdir(), "orgfit-attachments-"));
  Object.assign(process.env, {
    ATTACHMENT_ENCRYPTION_KEY: "c".repeat(64),
    ATTACHMENT_LOCAL_DIRECTORY: storage,
  });
  configureScanner(f.fixture.url("orgfit_scanner"));

  t.after(async () => {
    await closeScannerPool();
    await f.close();
  });

  const staff = f.staff;

  // A second staff member with visits.manage on organization B only, and a
  // third with organization A but no visits capability at all.
  const otherStaff = randomUUID();
  await f.operator.query(
    "insert into access.staff_user(id,issuer,provider_subject,email,display_name,role,status) values($1,$2,'other-visits','other-visits@example.invalid','موظف منظمة ب','STAFF','ACTIVE')",
    [otherStaff, process.env.OIDC_ISSUER],
  );
  await f.operator.query(
    "insert into access.organization_access values($1,$2)",
    [otherStaff, ids.orgB],
  );
  await f.operator.query(
    "insert into access.staff_capability(staff_user_id,capability) values($1,'visits.manage')",
    [otherStaff],
  );
  const otherToken = await f.session("other-visits");

  const uncapable = randomUUID();
  await f.operator.query(
    "insert into access.staff_user(id,issuer,provider_subject,email,display_name,role,status) values($1,$2,'no-visits','no-visits@example.invalid','موظف بلا صلاحية زيارات','STAFF','ACTIVE')",
    [uncapable, process.env.OIDC_ISSUER],
  );
  await f.operator.query(
    "insert into access.organization_access values($1,$2)",
    [uncapable, ids.orgA],
  );
  for (const capability of [
    "results.read",
    "campaigns.manage",
    "reports.manage",
  ])
    await f.operator.query(
      "insert into access.staff_capability(staff_user_id,capability) values($1,$2)",
      [uncapable, capability],
    );
  const uncapableToken = await f.session("no-visits");

  // A consultant who is active when assigned and disabled afterwards.
  const lapsing = randomUUID();
  await f.operator.query(
    "insert into access.staff_user(id,issuer,provider_subject,email,display_name,role,status) values($1,$2,'lapsing','lapsing@example.invalid','استشاري سيُعطّل','STAFF','ACTIVE')",
    [lapsing, process.env.OIDC_ISSUER],
  );
  await f.operator.query(
    "insert into access.organization_access values($1,$2)",
    [lapsing, ids.orgA],
  );
  await f.operator.query(
    "insert into access.staff_capability(staff_user_id,capability) values($1,'visits.manage')",
    [lapsing],
  );

  const route = (
    target: string,
    init: RequestInit | undefined,
    token: string,
  ) => {
    const [path] = target.split("?");
    const request = new Request(`http://127.0.0.1:3000/api/v1/${target}`, init);
    return withStaff(token, (tx) => visitRoute(request, path, tx));
  };
  const call = async (target: string, init?: RequestInit, token = staff) => {
    const res = await route(target, init, token);
    assert.ok(res, `${target} is not a route`);
    const body = await res.json();
    assert.ok(res.ok, `${target} -> ${res.status} ${JSON.stringify(body)}`);
    return { status: res.status, data: body.data };
  };
  const deny = (target: string, init?: RequestInit, token = staff) =>
    failure(async () => {
      const res = await route(target, init, token);
      if (!res) throw new Error("NO_ROUTE");
      if (!res.ok) throw new Error((await res.json()).code);
      return res;
    });
  const bytesOf = async (target: string, token = staff) => {
    const res = await route(target, undefined, token);
    assert.ok(res);
    return {
      status: res.status,
      headers: res.headers,
      bytes: Buffer.from(await res.arrayBuffer()),
    };
  };
  const post = (body: unknown) => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const patch = (body: unknown, revision: number | string) => ({
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
      "if-match": `"${revision}"`,
    },
    body: JSON.stringify(body),
  });
  const withRevision = (body: unknown, revision: number | string) => ({
    ...post(body),
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
      "if-match": `"${revision}"`,
    },
  });

  const orgA = ids.orgA;
  const round = await f.launchedCampaign();
  const visitBody = (overrides: Record<string, unknown> = {}) => ({
    relatedRoundId: null,
    assignedConsultantId: ids.staff,
    scheduledStart: "2026-09-20T07:00:00.000Z",
    scheduledEnd: "2026-09-20T12:00:00.000Z",
    timezone: "Asia/Riyadh",
    purpose: AR_PURPOSE,
    notes: null,
    findings: null,
    recommendations: null,
    followUpDate: null,
    amendmentReason: null,
    ...overrides,
  });

  type Visit = {
    id: string;
    state: string;
    revision: number;
    completedAt: string | null;
    amendmentCount: number;
    findings: string | null;
    relatedRoundId: string | null;
    assignedConsultantActive: boolean | null;
    followUps?: {
      id: string;
      status: string;
      revision: number;
      overdue: boolean;
    }[];
    attachments?: {
      id: string;
      scanStatus: string;
      downloadable: boolean;
      contentType: string | null;
      rejectionCode: string | null;
      originalName: string;
    }[];
  };

  // -------------------------------------------------------------------------
  await t.test(
    "V-1 the lifecycle is the one the blueprint specifies",
    async () => {
      const created = (await call(
        `organizations/${orgA}/visits`,
        post(visitBody({ relatedRoundId: round.roundId })),
      )) as { status: number; data: Visit };
      assert.equal(created.status, 201);
      assert.equal(created.data.state, "DRAFT");
      assert.equal(created.data.relatedRoundId, round.roundId);
      const id = created.data.id;
      const move = async (target: string, reason: string | null = null) => {
        const current = (await call(`organizations/${orgA}/visits/${id}`))
          .data as Visit;
        return (
          await call(
            `organizations/${orgA}/visits/${id}/transition`,
            withRevision({ target, reason }, current.revision),
          )
        ).data as Visit;
      };
      // Skipping a state is refused, not silently allowed.
      const current = (await call(`organizations/${orgA}/visits/${id}`))
        .data as Visit;
      assert.equal(
        await deny(
          `organizations/${orgA}/visits/${id}/transition`,
          withRevision({ target: "COMPLETED", reason: null }, current.revision),
        ),
        "STATE_CONFLICT",
      );
      assert.equal((await move("SCHEDULED")).state, "SCHEDULED");
      assert.equal(
        await deny(
          `organizations/${orgA}/visits/${id}/transition`,
          withRevision({ target: "SCHEDULED", reason: null }, 2),
        ),
        "STATE_CONFLICT",
      );
      assert.equal((await move("IN_PROGRESS")).state, "IN_PROGRESS");
      const completed = await move("COMPLETED");
      assert.equal(completed.state, "COMPLETED");
      assert.ok(completed.completedAt);

      // A completed visit does not reopen, by transition or by amendment.
      assert.equal(
        await deny(
          `organizations/${orgA}/visits/${id}/transition`,
          withRevision(
            { target: "IN_PROGRESS", reason: null },
            completed.revision,
          ),
        ),
        "STATE_CONFLICT",
      );
      // Editing it without a reason is refused; with one it is an audited
      // amendment that keeps the original completion instant.
      assert.equal(
        await deny(
          `organizations/${orgA}/visits/${id}`,
          patch(
            visitBody({ relatedRoundId: round.roundId, findings: AR_FINDINGS }),
            completed.revision,
          ),
        ),
        "AMENDMENT_REASON_REQUIRED",
      );
      const amended = (
        await call(
          `organizations/${orgA}/visits/${id}`,
          patch(
            visitBody({
              relatedRoundId: round.roundId,
              findings: AR_FINDINGS,
              amendmentReason: "تصحيح صياغة الملاحظات الميدانية",
            }),
            completed.revision,
          ),
        )
      ).data as Visit;
      assert.equal(amended.state, "COMPLETED");
      assert.equal(amended.amendmentCount, 1);
      assert.equal(amended.completedAt, completed.completedAt);
      assert.equal(amended.findings, AR_FINDINGS);
      const audit = await f.operator.query(
        "select action from ops.audit_log where target_id=$1 order by occurred_at",
        [id],
      );
      const actions = audit.rows.map((r) => r.action as string);
      assert.ok(actions.includes("VISIT_AMENDED"));
      assert.equal(actions.filter((a) => a === "VISIT_TRANSITIONED").length, 3);
    },
  );

  // -------------------------------------------------------------------------
  await t.test(
    "V-2 cancellation needs a reason and closes the record",
    async () => {
      const created = (
        await call(`organizations/${orgA}/visits`, post(visitBody()))
      ).data as Visit;
      assert.equal(
        await deny(
          `organizations/${orgA}/visits/${created.id}/transition`,
          withRevision({ target: "CANCELLED", reason: null }, created.revision),
        ),
        "VALIDATION_FAILED",
      );
      const cancelled = (
        await call(
          `organizations/${orgA}/visits/${created.id}/transition`,
          withRevision(
            { target: "CANCELLED", reason: "تأجيل بناءً على طلب المنظمة" },
            created.revision,
          ),
        )
      ).data as Visit;
      assert.equal(cancelled.state, "CANCELLED");
      // Nothing about a cancelled visit changes afterwards, including its content.
      assert.equal(
        await deny(
          `organizations/${orgA}/visits/${created.id}`,
          patch(visitBody({ notes: "لاحقًا" }), cancelled.revision),
        ),
        "STATE_CONFLICT",
      );
      assert.equal(
        await deny(
          `organizations/${orgA}/visits/${created.id}/transition`,
          withRevision(
            { target: "SCHEDULED", reason: null },
            cancelled.revision,
          ),
        ),
        "STATE_CONFLICT",
      );
    },
  );

  // -------------------------------------------------------------------------
  await t.test("V-3 an inactive consultant cannot be given work", async () => {
    const created = (await call(
      `organizations/${orgA}/visits`,
      post(visitBody({ assignedConsultantId: lapsing })),
    )) as { data: Visit };
    // Disabled after the assignment. The record keeps the history and says so.
    await f.operator.query(
      "update access.staff_user set status='DISABLED' where id=$1",
      [lapsing],
    );
    const read = (await call(`organizations/${orgA}/visits/${created.data.id}`))
      .data as Visit;
    assert.equal(read.assignedConsultantActive, false);
    // It cannot move forward onto that person, and cannot be re-saved with them.
    assert.equal(
      await deny(
        `organizations/${orgA}/visits/${created.data.id}/transition`,
        withRevision({ target: "SCHEDULED", reason: null }, read.revision),
      ),
      "CONSULTANT_INACTIVE",
    );
    assert.equal(
      await deny(
        `organizations/${orgA}/visits/${created.data.id}`,
        patch(visitBody({ assignedConsultantId: lapsing }), read.revision),
      ),
      "CONSULTANT_INACTIVE",
    );
    // Reassigning to an active consultant unblocks it.
    const reassigned = (
      await call(
        `organizations/${orgA}/visits/${created.data.id}`,
        patch(visitBody({ assignedConsultantId: ids.staff }), read.revision),
      )
    ).data as Visit;
    assert.equal(reassigned.assignedConsultantActive, true);
    // A staff member of another organization is not an eligible consultant here.
    assert.equal(
      await deny(
        `organizations/${orgA}/visits`,
        post(visitBody({ assignedConsultantId: otherStaff })),
      ),
      "CONSULTANT_INACTIVE",
    );
    await f.operator.query(
      "update access.staff_user set status='ACTIVE' where id=$1",
      [lapsing],
    );
  });

  // -------------------------------------------------------------------------
  await t.test(
    "V-4 organizations and capabilities are separate walls",
    async () => {
      const mine = (
        await call(`organizations/${orgA}/visits`, post(visitBody()))
      ).data as Visit;
      // Another organization's staff sees an absent object, not a forbidden one.
      assert.equal(
        await deny(
          `organizations/${orgA}/visits/${mine.id}`,
          undefined,
          otherToken,
        ),
        "NOT_FOUND",
      );
      assert.equal(
        await deny(`organizations/${orgA}/visits`, undefined, otherToken),
        "NOT_FOUND",
      );
      // Staff of this organization without visits.manage is forbidden, and the
      // capabilities that reach results, campaigns and reports reach nothing here.
      assert.equal(
        await deny(`organizations/${orgA}/visits`, undefined, uncapableToken),
        "FORBIDDEN",
      );
      assert.equal(
        await deny(
          `organizations/${orgA}/visits/${mine.id}`,
          undefined,
          uncapableToken,
        ),
        "FORBIDDEN",
      );
      // A round belonging to organization A cannot be attached to a visit of B.
      assert.equal(
        await deny(
          `organizations/${ids.orgB}/visits`,
          post(
            visitBody({
              relatedRoundId: round.roundId,
              assignedConsultantId: otherStaff,
            }),
          ),
          otherToken,
        ),
        "NOT_FOUND",
      );
    },
  );

  // -------------------------------------------------------------------------
  await t.test(
    "V-5 follow-up actions are an internal list with filters",
    async () => {
      const visit = (
        await call(`organizations/${orgA}/visits`, post(visitBody()))
      ).data as Visit;
      const overdueAction = (
        await call(
          `organizations/${orgA}/visits/${visit.id}/follow-ups`,
          post({
            title: "توثيق قنوات التصعيد للمشرفين الجدد",
            ownerStaffId: ids.staff,
            dueDate: "2026-01-15",
            status: "OPEN",
            notes: null,
            closureReason: null,
          }),
        )
      ).data as { id: string; revision: number; overdue: boolean };
      assert.equal(overdueAction.overdue, true);
      await call(
        `organizations/${orgA}/visits/${visit.id}/follow-ups`,
        post({
          title: "مراجعة جدول المناوبات",
          ownerStaffId: ids.staff,
          dueDate: "2027-06-01",
          status: "OPEN",
          notes: null,
          closureReason: null,
        }),
      );
      const open = (
        await call(
          `organizations/${orgA}/follow-ups?status=OPEN&dueBefore=2026-09-10`,
        )
      ).data as { items: { id: string; overdue: boolean }[] };
      assert.ok(open.items.some((i) => i.id === overdueAction.id));
      assert.ok(open.items.every((i) => i.overdue));
      // Cancelling one requires saying why.
      assert.equal(
        await deny(
          `organizations/${orgA}/visits/${visit.id}/follow-ups/${overdueAction.id}`,
          patch(
            {
              title: "توثيق قنوات التصعيد للمشرفين الجدد",
              ownerStaffId: ids.staff,
              dueDate: "2026-01-15",
              status: "CANCELLED",
              notes: null,
              closureReason: null,
            },
            overdueAction.revision,
          ),
        ),
        "VALIDATION_FAILED",
      );
      const done = (
        await call(
          `organizations/${orgA}/visits/${visit.id}/follow-ups/${overdueAction.id}`,
          patch(
            {
              title: "توثيق قنوات التصعيد للمشرفين الجدد",
              ownerStaffId: ids.staff,
              dueDate: "2026-01-15",
              status: "DONE",
              notes: "أُنجز مع مدير التشغيل",
              closureReason: null,
            },
            overdueAction.revision,
          ),
        )
      ).data as { status: string; overdue: boolean };
      assert.equal(done.status, "DONE");
      assert.equal(done.overdue, false);
      // A follow-up of another organization's visit is unreachable.
      assert.equal(
        await deny(
          `organizations/${ids.orgB}/visits/${visit.id}/follow-ups`,
          post({
            title: "x",
            ownerStaffId: otherStaff,
            dueDate: "2027-01-01",
            status: "OPEN",
            notes: null,
            closureReason: null,
          }),
          otherToken,
        ),
        "NOT_FOUND",
      );
      // An unsupported filter is refused rather than ignored.
      assert.equal(
        await deny(`organizations/${orgA}/follow-ups?visitId=${visit.id}`),
        "UNSUPPORTED_FILTER",
      );
    },
  );

  // -------------------------------------------------------------------------
  // The upload helper used by every attachment subtest below. It is the real
  // two-call protocol, not a shortcut into the database.
  const upload = async (
    visitId: string,
    filename: string,
    declaredType: string,
    bytes: Buffer,
    token = staff,
  ) => {
    const started = (
      await call(
        `organizations/${orgA}/visits/${visitId}/attachments`,
        post({ filename, declaredType }),
        token,
      )
    ).data as { id: string; scanStatus: string };
    const res = await route(
      `organizations/${orgA}/visits/${visitId}/attachments/${started.id}/content`,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(bytes),
      },
      token,
    );
    assert.ok(res);
    return { id: started.id, status: res.status };
  };
  const scanOnce = () => scanDueAttachments(scannerPool(), 10);
  const attachmentsOf = async (visitId: string, token = staff) =>
    (
      (await call(`organizations/${orgA}/visits/${visitId}`, undefined, token))
        .data as Visit
    ).attachments ?? [];

  await t.test(
    "V-6 a file is quarantined until something reads it",
    async () => {
      await scannerReadiness();
      const visit = (
        await call(`organizations/${orgA}/visits`, post(visitBody()))
      ).data as Visit;
      const pdf = await upload(
        visit.id,
        "تقرير-الزيارة.pdf",
        "application/pdf",
        pdfBytes(),
      );
      assert.equal(pdf.status, 202);
      let listed = await attachmentsOf(visit.id);
      assert.equal(listed[0].scanStatus, "QUARANTINED");
      assert.equal(listed[0].downloadable, false);
      // Downloading before the verdict is refused, and refused as a conflict
      // rather than by quietly serving unscanned bytes.
      assert.equal(
        await deny(
          `organizations/${orgA}/visits/${visit.id}/attachments/${pdf.id}/download`,
        ),
        "ATTACHMENT_UNAVAILABLE",
      );
      const outcomes = await scanOnce();
      assert.ok(
        outcomes.some((o) => o.attachmentId === pdf.id && o.state === "CLEAN"),
      );
      listed = await attachmentsOf(visit.id);
      assert.equal(listed[0].scanStatus, "CLEAN");
      assert.equal(listed[0].contentType, "application/pdf");
      assert.equal(listed[0].downloadable, true);
      // The bytes come back exactly, as an attachment, never sniffed or framed.
      const got = await bytesOf(
        `organizations/${orgA}/visits/${visit.id}/attachments/${pdf.id}/download`,
      );
      assert.deepEqual(got.bytes, pdfBytes());
      assert.equal(got.headers.get("content-type"), "application/octet-stream");
      assert.match(
        got.headers.get("content-disposition") ?? "",
        /^attachment; filename\*=UTF-8''/,
      );
      assert.equal(got.headers.get("x-content-type-options"), "nosniff");
      assert.match(
        got.headers.get("content-security-policy") ?? "",
        /^sandbox;/,
      );
      // The Arabic filename survives the header round trip.
      assert.equal(
        decodeURIComponent(
          (got.headers.get("content-disposition") ?? "").split("''")[1],
        ),
        "تقرير-الزيارة.pdf",
      );
      // A PDF previews inline under the sandbox policy; a workbook does not.
      const preview = await bytesOf(
        `organizations/${orgA}/visits/${visit.id}/attachments/${pdf.id}/preview`,
      );
      assert.equal(preview.headers.get("content-type"), "application/pdf");
      assert.match(
        preview.headers.get("content-disposition") ?? "",
        /^inline; filename/,
      );
    },
  );

  await t.test("V-7 malicious and mislabelled files are rejected", async () => {
    const visit = (
      await call(`organizations/${orgA}/visits`, post(visitBody()))
    ).data as Visit;
    const cases: {
      name: string;
      filename: string;
      declaredType: string;
      bytes: Buffer;
      code: string;
    }[] = [
      {
        name: "an executable renamed as a PDF",
        filename: "invoice.pdf",
        declaredType: "application/pdf",
        bytes: Buffer.concat([
          Buffer.from([0x4d, 0x5a]),
          Buffer.alloc(128, 0x90),
        ]),
        code: "ACTIVE_CONTENT",
      },
      {
        name: "an HTML page renamed as a PNG",
        filename: "chart.png",
        declaredType: "image/png",
        bytes: Buffer.from(
          "<html><script>fetch('http://attacker.invalid')</script></html>",
          "utf8",
        ),
        code: "ACTIVE_CONTENT",
      },
      {
        name: "an SVG renamed as a JPEG",
        filename: "logo.jpg",
        declaredType: "image/jpeg",
        bytes: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
          "utf8",
        ),
        code: "ACTIVE_CONTENT",
      },
      {
        name: "a PNG declared and named as a PDF",
        filename: "report.pdf",
        declaredType: "application/pdf",
        bytes: pngBytes(),
        code: "TYPE_MISMATCH",
      },
      {
        name: "the EICAR test sample",
        filename: "sample.pdf",
        declaredType: "application/pdf",
        bytes: Buffer.from(EICAR_BODY, "latin1"),
        code: "MALWARE_SIGNATURE",
      },
      {
        name: "a macro-enabled document",
        filename: "notes.docx",
        declaredType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: await docxBytes({ name: "word/vbaProject.bin", content: "MZ" }),
        code: "MACRO_CONTENT",
      },
      {
        name: "a document carrying a nested archive",
        filename: "bundle.docx",
        declaredType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: await docxBytes({ name: "word/payload.zip", content: "PK" }),
        code: "NESTED_ARCHIVE",
      },
    ];
    for (const c of cases) {
      const up = await upload(visit.id, c.filename, c.declaredType, c.bytes);
      await scanOnce();
      const listed = await attachmentsOf(visit.id);
      const row = listed.find((a) => a.id === up.id);
      assert.ok(row, `${c.name} produced no row`);
      assert.equal(row.scanStatus, "REJECTED", c.name);
      assert.equal(row.rejectionCode, c.code, c.name);
      assert.equal(row.downloadable, false, c.name);
      assert.equal(
        await deny(
          `organizations/${orgA}/visits/${visit.id}/attachments/${up.id}/download`,
        ),
        "ATTACHMENT_UNAVAILABLE",
        c.name,
      );
    }
    // A clean Word document is accepted, so the rejections above are not a
    // blanket refusal of the format.
    const good = await upload(
      visit.id,
      "ملاحظات.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      await docxBytes(),
    );
    await scanOnce();
    const row = (await attachmentsOf(visit.id)).find((a) => a.id === good.id);
    assert.equal(row?.scanStatus, "CLEAN");
    // A type outside the allowlist never reaches storage at all.
    assert.equal(
      await deny(
        `organizations/${orgA}/visits/${visit.id}/attachments`,
        post({ filename: "script.sh", declaredType: "text/x-shellscript" }),
      ),
      "VALIDATION_FAILED",
    );
    // Neither does a filename shaped like a path.
    assert.equal(
      await deny(
        `organizations/${orgA}/visits/${visit.id}/attachments`,
        post({
          filename: "../../etc/passwd.pdf",
          declaredType: "application/pdf",
        }),
      ),
      "VALIDATION_FAILED",
    );
  });

  await t.test("V-8 size is bounded before anything is stored", async () => {
    const visit = (
      await call(`organizations/${orgA}/visits`, post(visitBody()))
    ).data as Visit;
    const started = (
      await call(
        `organizations/${orgA}/visits/${visit.id}/attachments`,
        post({ filename: "huge.pdf", declaredType: "application/pdf" }),
      )
    ).data as { id: string; maxBytes: number };
    assert.equal(started.maxBytes, 20 * 1024 * 1024);
    const oversize = Buffer.concat([
      pdfBytes(),
      Buffer.alloc(started.maxBytes, 0x20),
    ]);
    // The route refuses before a byte reaches storage. The HTTP layer turns
    // this into 413; here the code itself is the assertion.
    assert.equal(
      await deny(
        `organizations/${orgA}/visits/${visit.id}/attachments/${started.id}/content`,
        {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: new Uint8Array(oversize),
        },
      ),
      "ATTACHMENT_TOO_LARGE",
    );
    // The row never left UPLOADING, so nothing is listed as available.
    const listed = await attachmentsOf(visit.id);
    assert.equal(
      listed.find((a) => a.id === started.id)?.scanStatus,
      "UPLOADING",
    );
  });

  await t.test("V-9 a scanner outage fails closed and retries", async () => {
    const visit = (
      await call(`organizations/${orgA}/visits`, post(visitBody()))
    ).data as Visit;
    const up = await upload(
      visit.id,
      "missing.pdf",
      "application/pdf",
      pdfBytes(),
    );
    // Simulate an unreadable object: the row is quarantined and the bytes are
    // gone. This is the outage shape, not a verdict.
    await deleteAttachment(orgA, up.id);
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcomes = await scanOnce();
      const mine = outcomes.find((o) => o.attachmentId === up.id);
      assert.ok(mine, `attempt ${attempt} did not claim the row`);
      assert.ok(
        ["QUARANTINED", "FAILED"].includes(mine.state),
        `attempt ${attempt} produced ${mine.state}`,
      );
      // At no point is it downloadable.
      assert.equal(
        await deny(
          `organizations/${orgA}/visits/${visit.id}/attachments/${up.id}/download`,
        ),
        "ATTACHMENT_UNAVAILABLE",
      );
    }
    const row = (await attachmentsOf(visit.id)).find((a) => a.id === up.id);
    assert.equal(row?.scanStatus, "FAILED");
    assert.equal(row?.downloadable, false);
    // The attempt budget is spent, so the worker stops claiming it rather than
    // spinning on a file it can never read.
    const after = await scanOnce();
    assert.ok(!after.some((o) => o.attachmentId === up.id));
  });

  await t.test(
    "V-10 download authorization is re-checked, and expires",
    async () => {
      const visit = (
        await call(`organizations/${orgA}/visits`, post(visitBody()))
      ).data as Visit;
      const up = await upload(visit.id, "photo.png", "image/png", pngBytes());
      await scanOnce();
      assert.equal(
        (await attachmentsOf(visit.id)).find((a) => a.id === up.id)?.scanStatus,
        "CLEAN",
      );
      // Another organization's staff cannot reach it even with the exact ids.
      assert.equal(
        await deny(
          `organizations/${orgA}/visits/${visit.id}/attachments/${up.id}/download`,
          undefined,
          otherToken,
        ),
        "NOT_FOUND",
      );
      // Naming it under the other organization does not move it there.
      assert.equal(
        await deny(
          `organizations/${ids.orgB}/visits/${visit.id}/attachments/${up.id}/download`,
          undefined,
          otherToken,
        ),
        "NOT_FOUND",
      );
      // Losing the capability after the scan stops the download. The capability
      // change bumps the auth epoch, so a fresh session is issued for the check.
      await f.operator.query(
        "delete from access.staff_capability where staff_user_id=$1 and capability='visits.manage'",
        [ids.staff],
      );
      const revoked = await f.session("staff");
      assert.equal(
        await deny(
          `organizations/${orgA}/visits/${visit.id}/attachments/${up.id}/download`,
          undefined,
          revoked,
        ),
        "FORBIDDEN",
      );
      await f.operator.query(
        "insert into access.staff_capability(staff_user_id,capability) values($1,'visits.manage')",
        [ids.staff],
      );
      const restored = await f.session("staff");
      const got = await bytesOf(
        `organizations/${orgA}/visits/${visit.id}/attachments/${up.id}/download`,
        restored,
      );
      assert.equal(got.status, 200);

      // Retention: an expired attachment stops downloading even while its row and
      // its audit trail remain.
      await f.operator.query(
        "update core.attachment set expires_at=clock_timestamp()-interval '1 second' where id=$1",
        [up.id],
      );
      assert.equal(
        await deny(
          `organizations/${orgA}/visits/${visit.id}/attachments/${up.id}/download`,
          undefined,
          restored,
        ),
        "IMPORT_EXPIRED",
      );
      // Deletion retires the row and removes the bytes; the record survives.
      const second = await upload(
        visit.id,
        "second.png",
        "image/png",
        pngBytes(),
        restored,
      );
      await scanOnce();
      const removeRes = await route(
        `organizations/${orgA}/visits/${visit.id}/attachments/${second.id}`,
        { method: "DELETE" },
        restored,
      );
      assert.ok(removeRes);
      assert.equal(removeRes.status, 200);
      assert.ok(
        !(await attachmentsOf(visit.id, restored)).some(
          (a) => a.id === second.id,
        ),
      );
      const surviving = await f.operator.query(
        "select scan_status from core.attachment where id=$1",
        [second.id],
      );
      assert.equal(surviving.rows[0].scan_status, "EXPIRED");
      const deleteAudit = await f.operator.query(
        "select count(*)::int as n from ops.audit_log where target_id=$1 and action='ATTACHMENT_DELETED'",
        [second.id],
      );
      assert.equal(deleteAudit.rows[0].n, 1);
    },
  );

  await t.test(
    "V-11 the scanner credential can reach nothing else",
    async () => {
      await scannerReadiness();
      // No table privilege anywhere, and no membership of any other identity.
      const { rows } = await scannerPool().query<{ n: string }>(
        "select count(*)::text as n from information_schema.table_privileges where grantee='orgfit_scanner'",
      );
      assert.equal(rows[0].n, "0");
      for (const statement of [
        "select * from core.field_visit",
        "select * from core.attachment",
        "select * from core.participant",
        "select * from access.staff_user",
        "select core.visit_detail($1,$1)",
      ]) {
        const failed = await failure(async () =>
          scannerPool().query(
            statement,
            statement.includes("$1") ? [orgA] : [],
          ),
        );
        assert.notEqual(failed, "NO_ERROR", statement);
      }
      // And a scanner process holding any other credential refuses to start.
      for (const key of [
        "DATABASE_URL",
        "REPORT_DATABASE_URL",
        "REPORT_ENCRYPTION_KEY",
        "CAMPAIGN_KEY_CUSTODY_SECRET_KEY",
      ])
        assert.throws(() =>
          assertNoForeignCredentials({
            [key]: "present",
            SCANNER_DATABASE_URL: "x",
          }),
        );
    },
  );

  await t.test(
    "V-12 a visit cannot name a response, and never could",
    async () => {
      // The structural claim, asserted against the live catalog rather than
      // against a comment: no column of any Phase 12 table is a foreign key into
      // anything holding, or pointing at, respondent data.
      const { rows: columns } = await f.operator.query<{
        table_name: string;
        column_name: string;
      }>(
        `select table_name,column_name from information_schema.columns
        where table_schema='core' and table_name in ('field_visit','visit_follow_up','attachment')`,
      );
      const forbidden =
        /response|answer|invitation|participant|draft|envelope|submission|token|anonymous/i;
      for (const c of columns)
        assert.ok(
          !forbidden.test(c.column_name),
          `${c.table_name}.${c.column_name} names respondent data`,
        );
      const { rows: references } = await f.operator.query<{
        table_name: string;
        referenced: string;
      }>(
        `select tc.table_name, ccu.table_schema||'.'||ccu.table_name as referenced
         from information_schema.table_constraints tc
         join information_schema.constraint_column_usage ccu
           on ccu.constraint_name=tc.constraint_name
        where tc.constraint_type='FOREIGN KEY' and tc.table_schema='core'
          and tc.table_name in ('field_visit','visit_follow_up','attachment')`,
      );
      const allowed = new Set([
        "core.organization",
        "core.assessment_round",
        "core.field_visit",
        "access.staff_user",
      ]);
      for (const r of references)
        assert.ok(
          allowed.has(r.referenced),
          `${r.table_name} references ${r.referenced}`,
        );
      assert.ok(
        references.some((r) => r.referenced === "core.assessment_round"),
      );
    },
  );

  await t.test(
    "V-13 the sniffer is decided by bytes, not by names",
    async () => {
      // The pure half, exercised directly so the interesting inputs are data.
      assert.equal(sniff(pdfBytes()), "application/pdf");
      assert.equal(sniff(pngBytes()), "image/png");
      assert.equal(sniff(Buffer.from("plain text", "utf8")), null);
      assert.equal(
        (
          await verifyAttachment({
            bytes: pdfBytes(),
            filename: "report.PDF",
            declaredType: "application/pdf; charset=binary",
          })
        ).verdict,
        "CLEAN",
      );
      // The right bytes with the wrong extension is still a rejection.
      assert.deepEqual(
        await verifyAttachment({
          bytes: pdfBytes(),
          filename: "report.png",
          declaredType: "application/pdf",
        }),
        { verdict: "REJECTED", code: "EXTENSION_MISMATCH" },
      );
      assert.deepEqual(
        await verifyAttachment({
          bytes: Buffer.alloc(0),
          filename: "empty.pdf",
          declaredType: "application/pdf",
        }),
        { verdict: "REJECTED", code: "EMPTY" },
      );
      // A bare zip is not a document, whatever it is called.
      const zip = new JSZip();
      zip.file("readme.txt", "hello");
      assert.deepEqual(
        await verifyAttachment({
          bytes: Buffer.from(await zip.generateAsync({ type: "nodebuffer" })),
          filename: "notes.docx",
          declaredType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
        { verdict: "REJECTED", code: "TYPE_NOT_ALLOWED" },
      );
    },
  );
});
