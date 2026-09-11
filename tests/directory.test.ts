import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import ExcelJS from "exceljs";
import { setupDatabase } from "./database";
import { ids } from "../scripts/seed";
import { withStaff } from "../src/db";
import { secret, digest } from "../src/security";
import {
  directoryRoute,
  directoryGet,
  saveDirectory,
  directoryList,
} from "../src/directory";
import { importRoute } from "../src/imports";
import { parseSource, validateRows, errorCsv } from "../src/import-parser";
import { getSource, cleanLocalSources } from "../src/import-storage";
import { directoryMessages } from "../src/directory-i18n";

test("CSV/XLSX parsing and reviewed row validation", async () => {
  const source = await parseSource(
    Buffer.from(
      '\uFEFFref,name,dept\r\nA,"اسم, عربي",HR\r\nB,Other,MISSING\r\nA,Duplicate,HR\r\nC,Valid,HR\r\n',
    ),
    "CSV",
  );
  const review = validateRows(
    source,
    { ref: "privateReference", name: "displayName", dept: "departmentCode" },
    [{ id: ids.orgA, code: "HR" }],
    new Set(),
  );
  assert.deepEqual(
    review.valid.map((v) => v.row),
    [5],
  );
  assert.deepEqual(
    review.errors.map((e) => e.code),
    ["DUPLICATE_REFERENCE", "INVALID_DEPARTMENT", "DUPLICATE_REFERENCE"],
  );
  assert(!errorCsv(review.errors).includes("اسم"));
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet("Directory");
  sheet.addRows([
    ["ref", "name"],
    ["001", "اسم عربي"],
  ]);
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  const parsed = await parseSource(bytes, "XLSX");
  assert.equal(parsed.rows[0][0], "001");
  sheet.getCell("B2").value = { formula: "1+1", result: 2 };
  await assert.rejects(
    parseSource(Buffer.from(await book.xlsx.writeBuffer()), "XLSX"),
  );
  await assert.rejects(parseSource(Buffer.from("x,x\n1,2"), "CSV"));
  await assert.rejects(parseSource(Buffer.from('x,y\n"bad'), "CSV"));
  await assert.rejects(
    parseSource(
      Buffer.from("x,y\n" + Array(501).fill("1,2").join("\n")),
      "CSV",
    ),
  );
  assert.deepEqual(
    Object.keys(directoryMessages("ar")).sort(),
    Object.keys(directoryMessages("en")).sort(),
  );
});

test("directory PostgreSQL isolation, history and import transactions", async (t) => {
  const fixture = await setupDatabase();
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
    IMPORT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  });
  delete process.env.MIGRATION_DATABASE_URL;
  const auth = new pg.Client({ connectionString: fixture.url("orgfit_auth") }),
    operator = new pg.Client({
      connectionString: fixture.url("orgfit_migrator"),
    }),
    runtime = new pg.Client({ connectionString: fixture.url("orgfit_staff") });
  await Promise.all([auth.connect(), operator.connect(), runtime.connect()]);
  await operator.query("SET ROLE orgfit_core_owner");
  const staffToken = secret(),
    adminToken = secret();
  for (const [token, sub] of [
    [staffToken, "staff"],
    [adminToken, "admin"],
  ])
    await auth.query("select access.issue_session($1,$2,$3)", [
      "http://127.0.0.1:4010",
      sub,
      digest(token),
    ]);
  const save = (
    token: string,
    kind: "organization" | "department" | "participant",
    org: string | null,
    body: unknown,
    id: string | null = null,
    revision: string | null = null,
    key = randomUUID(),
    archive = false,
  ) =>
    withStaff(token, (tx) =>
      saveDirectory(tx, kind, org, id, revision, body, key, archive),
    );
  const call = async (
    token: string,
    route: string,
    method = "GET",
    body?: unknown,
    revision?: string,
    key = randomUUID(),
  ) =>
    withStaff(token, async (tx, p) => {
      const req = new Request("http://127.0.0.1:3000/api/v1/" + route, {
        method,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
          ...(revision ? { "If-Match": `"${revision}"` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const r =
        (await directoryRoute(req, route, tx, p)) ??
        (await importRoute(req, route, tx));
      assert(r);
      return r;
    });
  const data = async (r: Promise<Response>) => (await (await r).json()).data;
  let deptA: string, deptB: string, personA: string;
  try {
    await t.test(
      "scoped references, capabilities, runtime write and FK denials",
      async () => {
        deptA = (
          await save(staffToken, "department", ids.orgA, {
            code: "HR",
            nameAr: "الموارد",
          })
        ).id;
        deptB = (
          await save(adminToken, "department", ids.orgB, {
            code: "HR",
            nameAr: "الموارد ب",
          })
        ).id;
        personA = (
          await save(staffToken, "participant", ids.orgA, {
            privateReference: "SAME",
            displayName: "Person A",
            departmentId: deptA,
          })
        ).id;
        await save(adminToken, "participant", ids.orgB, {
          privateReference: "SAME",
          displayName: "Person B",
          departmentId: deptB,
        });
        await assert.rejects(
          save(staffToken, "participant", ids.orgA, {
            privateReference: "BAD",
            displayName: "Bad",
            departmentId: deptB,
          }),
        );
        await assert.rejects(
          save(staffToken, "department", ids.orgA, {
            code: "BAD",
            nameAr: "bad",
            parentDepartmentId: deptB,
          }),
        );
        for (const kind of ["departments", "participants"]) {
          await assert.rejects(
            call(staffToken, `organizations/${ids.orgB}/${kind}`),
            /NOT_FOUND/,
          );
          await assert.rejects(
            call(
              staffToken,
              `organizations/${ids.orgB}/${kind}/${kind === "departments" ? deptB : personA}`,
            ),
            /NOT_FOUND/,
          );
          await assert.rejects(
            call(staffToken, `organizations/${ids.orgB}/${kind}`, "POST", {}),
            /NOT_FOUND/,
          );
          await assert.rejects(
            call(
              staffToken,
              `organizations/${ids.orgB}/${kind}/${personA}`,
              "PATCH",
              {},
              "1",
            ),
            /NOT_FOUND/,
          );
          await assert.rejects(
            call(
              staffToken,
              `organizations/${ids.orgB}/${kind}/${personA}/archive`,
              "POST",
              { reason: "test" },
              "1",
            ),
            /NOT_FOUND/,
          );
        }
        await assert.rejects(
          save(staffToken, "organization", null, {
            code: "NO",
            nameAr: "bad",
            timezone: "Asia/Riyadh",
          }),
          /FORBIDDEN/,
        );
        await assert.rejects(
          save(
            staffToken,
            "organization",
            ids.orgA,
            { reason: "no" },
            ids.orgA,
            "1",
            randomUUID(),
            true,
          ),
          /FORBIDDEN/,
        );
        for (const table of ["department", "participant", "directory_import"]) {
          assert.equal(
            (await runtime.query(`select * from core.${table}`)).rowCount,
            0,
          );
          await assert.rejects(runtime.query(`delete from core.${table}`));
          await assert.rejects(auth.query(`select * from core.${table}`));
        }
        await assert.rejects(
          operator.query(
            "insert into core.participant(organization_id,private_reference,display_name,department_id) values($1,'FK','FK',$2)",
            [ids.orgA, deptB],
          ),
          /foreign key/,
        );
      },
    );
    await t.test(
      "pagination is scoped and complete; revisions, retries, tree and archive guards",
      async () => {
        const a = await withStaff(staffToken, (tx) =>
          directoryList(
            tx,
            "participant",
            ids.orgA,
            new URL("http://x?limit=1"),
          ),
        );
        assert.equal(a.items.length, 1);
        const key = randomUUID(),
          created = await save(
            staffToken,
            "participant",
            ids.orgA,
            { privateReference: "SECOND", displayName: "Second" },
            null,
            null,
            key,
          );
        assert.equal(
          (
            await save(
              staffToken,
              "participant",
              ids.orgA,
              { privateReference: "SECOND", displayName: "Second" },
              null,
              null,
              key,
            )
          ).id,
          created.id,
        );
        await assert.rejects(
          save(
            staffToken,
            "participant",
            ids.orgA,
            { privateReference: "DIFFERENT", displayName: "Second" },
            null,
            null,
            key,
          ),
          /IDEMPOTENCY_CONFLICT/,
        );
        const first = await withStaff(staffToken, (tx) =>
          directoryList(
            tx,
            "participant",
            ids.orgA,
            new URL("http://x?limit=1"),
          ),
        );
        assert(first.nextCursor);
        const second = await withStaff(staffToken, (tx) =>
          directoryList(
            tx,
            "participant",
            ids.orgA,
            new URL(
              "http://x?limit=1&cursor=" +
                encodeURIComponent(first.nextCursor!),
            ),
          ),
        );
        assert.notEqual(first.items[0].id, second.items[0].id);
        assert.equal(second.nextCursor, null);
        await assert.rejects(
          withStaff(adminToken, (tx) =>
            directoryList(
              tx,
              "participant",
              ids.orgB,
              new URL(
                "http://x?cursor=" + encodeURIComponent(first.nextCursor!),
              ),
            ),
          ),
        );
        const child = await save(staffToken, "department", ids.orgA, {
          code: "CHILD",
          nameAr: "Child",
          parentDepartmentId: deptA,
        });
        await assert.rejects(
          save(
            staffToken,
            "department",
            ids.orgA,
            { code: "HR", nameAr: "الموارد", parentDepartmentId: child.id },
            deptA,
            "1",
          ),
          /DEPARTMENT_CYCLE/,
        );
        await assert.rejects(
          save(
            staffToken,
            "department",
            ids.orgA,
            { reason: "test" },
            deptA,
            "1",
            randomUUID(),
            true,
          ),
          /DEPARTMENT_IN_USE/,
        );
        await assert.rejects(
          save(
            staffToken,
            "participant",
            ids.orgA,
            { privateReference: "SAME", displayName: "Stale" },
            personA,
            "99",
          ),
          /REVISION_CONFLICT/,
        );
        await save(
          staffToken,
          "participant",
          ids.orgA,
          { reason: "test" },
          created.id,
          "1",
          randomUUID(),
          true,
        );
        assert.equal(
          (
            await withStaff(staffToken, (tx) =>
              directoryGet(tx, "participant", ids.orgA, created.id),
            )
          ).status,
          "ARCHIVED",
        );
        await assert.rejects(
          save(staffToken, "participant", ids.orgA, {
            privateReference: "SECOND",
            displayName: "Reuse",
          }),
        );
        await assert.rejects(
          save(
            staffToken,
            "department",
            ids.orgA,
            { code: "OTHER", nameAr: "Substitution" },
            deptB,
            "1",
          ),
          /NOT_FOUND/,
        );
      },
    );
    await t.test(
      "encrypted source, dry run, scoped downloads, commit replay and concurrent commit",
      async () => {
        const endpoint = `organizations/${ids.orgA}/imports`,
          source =
            "ref,name,dept\nNEW,اسم مستورد,HR\nSAME,Duplicate,HR\nNO_DEPT,Invalid,FOREIGN";
        const body = {
            format: "CSV",
            base64: Buffer.from(source).toString("base64"),
          },
          key = randomUUID();
        const uploaded = await data(
          call(staffToken, endpoint, "POST", body, undefined, key),
        );
        assert.equal(
          (await data(call(staffToken, endpoint, "POST", body, undefined, key)))
            .id,
          uploaded.id,
        );
        await assert.rejects(
          call(
            staffToken,
            endpoint,
            "POST",
            {
              ...body,
              base64: Buffer.from(source + "\nX,X,HR").toString("base64"),
            },
            undefined,
            key,
          ),
          /IDEMPOTENCY_CONFLICT/,
        );
        const file = resolve("work/imports", ids.orgA, uploaded.id + ".bin"),
          cipher = await readFile(file);
        assert(!cipher.includes(Buffer.from("اسم مستورد")));
        assert.equal(
          (await getSource(ids.orgA, uploaded.id)).toString(),
          source,
        );
        await writeFile(
          file,
          Buffer.concat([
            cipher.subarray(0, -1),
            Buffer.from([cipher.at(-1)! ^ 1]),
          ]),
        );
        await assert.rejects(getSource(ids.orgA, uploaded.id));
        await writeFile(file, cipher);
        const count = async () =>
            Number(
              (
                await operator.query(
                  "select count(*) n from core.participant where organization_id=$1",
                  [ids.orgA],
                )
              ).rows[0].n,
            ),
          before = await count();
        const reviewed = await data(
          call(
            staffToken,
            `${endpoint}/${uploaded.id}/validate`,
            "POST",
            {
              mapping: {
                ref: "privateReference",
                name: "displayName",
                dept: "departmentCode",
              },
            },
            "1",
          ),
        );
        assert.equal(await count(), before);
        assert.deepEqual(reviewed.validation.validRows, [2]);
        assert.equal(reviewed.validation.errors.length, 2);
        for (const suffix of ["", "/errors"])
          await assert.rejects(
            call(
              staffToken,
              `organizations/${ids.orgB}/imports/${uploaded.id}${suffix}`,
            ),
            /NOT_FOUND/,
          );
        for (const suffix of ["validate", "commit"])
          await assert.rejects(
            call(
              staffToken,
              `organizations/${ids.orgB}/imports/${uploaded.id}/${suffix}`,
              "POST",
              {},
              "2",
            ),
            /NOT_FOUND/,
          );
        await assert.rejects(
          call(adminToken, `organizations/${ids.orgB}/imports/${uploaded.id}`),
          /NOT_FOUND/,
        );
        const errors = await (
          await call(staffToken, `${endpoint}/${uploaded.id}/errors`)
        ).text();
        assert(errors.includes("DUPLICATE_REFERENCE"));
        assert(!errors.includes("Duplicate,"));
        const commit = {
          sourceDigest: reviewed.source_digest,
          validationRevision: "2",
          confirmValidRows: true,
        };
        const commitKey = randomUUID();
        const responses = await Promise.all([
          data(
            call(
              staffToken,
              `${endpoint}/${uploaded.id}/commit`,
              "POST",
              commit,
              "2",
              commitKey,
            ),
          ),
          data(
            call(
              staffToken,
              `${endpoint}/${uploaded.id}/commit`,
              "POST",
              commit,
              "2",
              commitKey,
            ),
          ),
        ]);
        assert(responses.every((r) => r.committed_count === 1));
        assert.equal(await count(), before + 1);
        await assert.rejects(
          call(
            staffToken,
            `${endpoint}/${uploaded.id}/commit`,
            "POST",
            { ...commit, validationRevision: "3" },
            "3",
            commitKey,
          ),
          /IDEMPOTENCY_CONFLICT/,
        );
        const book = new ExcelJS.Workbook();
        book.addWorksheet("People").addRows([
          ["ref", "name"],
          ["XLSX_001", "اسم إكسل"],
        ]);
        const xlsx = await data(
          call(staffToken, endpoint, "POST", {
            format: "XLSX",
            base64: Buffer.from(await book.xlsx.writeBuffer()).toString(
              "base64",
            ),
          }),
        );
        const xr = await data(
          call(
            staffToken,
            `${endpoint}/${xlsx.id}/validate`,
            "POST",
            { mapping: { ref: "privateReference", name: "displayName" } },
            "1",
          ),
        );
        assert.equal(
          (
            await data(
              call(
                staffToken,
                `${endpoint}/${xlsx.id}/commit`,
                "POST",
                {
                  sourceDigest: xr.source_digest,
                  validationRevision: "2",
                  confirmValidRows: true,
                },
                "2",
              ),
            )
          ).committed_count,
          1,
        );
        assert.equal(await count(), before + 2);
      },
    );
    await t.test(
      "new conflict blocks commit; expiry and capability revocation deny access",
      async () => {
        const endpoint = `organizations/${ids.orgA}/imports`,
          uploaded = await data(
            call(staffToken, endpoint, "POST", {
              format: "CSV",
              base64: Buffer.from("ref,name\nRACE,Race").toString("base64"),
            }),
          );
        const reviewed = await data(
          call(
            staffToken,
            `${endpoint}/${uploaded.id}/validate`,
            "POST",
            { mapping: { ref: "privateReference", name: "displayName" } },
            "1",
          ),
        );
        await save(staffToken, "participant", ids.orgA, {
          privateReference: "RACE",
          displayName: "Other",
        });
        await assert.rejects(
          call(
            staffToken,
            `${endpoint}/${uploaded.id}/commit`,
            "POST",
            {
              sourceDigest: reviewed.source_digest,
              validationRevision: "2",
              confirmValidRows: true,
            },
            "2",
          ),
          /IMPORT_CHANGED/,
        );
        await operator.query(
          "update core.directory_import set expires_at=clock_timestamp()-interval '1 second' where id=$1",
          [uploaded.id],
        );
        await assert.rejects(
          call(staffToken, `${endpoint}/${uploaded.id}/errors`),
          /IMPORT_EXPIRED/,
        );
        await operator.query(
          "delete from access.staff_capability where staff_user_id=$1 and capability='directory.manage'",
          [ids.staff],
        );
        await assert.rejects(
          call(staffToken, endpoint),
          /SESSION_REQUIRED|FORBIDDEN/,
        );
        await save(
          adminToken,
          "organization",
          ids.orgB,
          { reason: "test" },
          ids.orgB,
          "1",
          randomUUID(),
          true,
        );
        await assert.rejects(
          save(adminToken, "participant", ids.orgB, {
            privateReference: "ARCHIVE",
            displayName: "no",
          }),
          /STATE_CONFLICT/,
        );
        assert.equal(
          (
            await operator.query(
              "select count(*)::int n from core.participant where organization_id=$1",
              [ids.orgB],
            )
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await operator.query(
              "select count(*)::int n from ops.audit_log where action='DIRECTORY_CHANGED'",
            )
          ).rows[0].n > 0,
          true,
        );
        assert((await cleanLocalSources(Date.now() + 86400001)) >= 2);
      },
    );
  } finally {
    await Promise.all([auth.end(), operator.end(), runtime.end()]);
  }
});
