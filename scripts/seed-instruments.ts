import pg from "pg";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { illustrativeTemplates } from "../src/instrument-templates";
import { flattenInstrument, metadata } from "../src/instrument-records";
import { definitionIssues, canonicalJson } from "../src/instrument-input";
export async function seedInstruments(url: string) {
  if (new URL(url).username !== "orgfit_migrator")
    throw Error("Migration credential required");
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE orgfit_core_owner");
    await db.query("SELECT pg_advisory_xact_lock(80400)");
    await db.query(
      "INSERT INTO instrument.instrument_scope(organization_id) VALUES(NULL) ON CONFLICT DO NOTHING",
    );
    const scope = (
      await db.query(
        "SELECT id FROM instrument.instrument_scope WHERE organization_id IS NULL",
      )
    ).rows[0].id;
    for (const [index, d] of illustrativeTemplates().entries()) {
      const qid = `44000000-0000-4000-8000-00000000000${index + 1}`,
        vid = `44000000-0000-4000-9000-00000000000${index + 1}`;
      if (
        (
          await db.query(
            "SELECT id FROM instrument.questionnaire WHERE id=$1",
            [qid],
          )
        ).rowCount
      )
        continue;
      if (definitionIssues(d, true).length)
        throw Error("Invalid illustrative definition");
      await db.query(
        "INSERT INTO instrument.questionnaire(id,scope_id,name_ar,name_en,source) VALUES($1,$2,$3,$4,'BUILTIN')",
        [qid, scope, d.title.ar, d.title.en],
      );
      await db.query(
        "INSERT INTO instrument.questionnaire_version(id,scope_id,questionnaire_id,version_number,metadata) VALUES($1,$2,$3,1,$4)",
        [vid, scope, qid, metadata(d)],
      );
      for (const n of flattenInstrument(d).sort(
        (a, b) =>
          [
            "section",
            "dimension",
            "question",
            "question_option",
            "matrix_row",
            "matrix_column",
            "score_definition",
            "interpretation_band",
          ].indexOf(a.table) -
          [
            "section",
            "dimension",
            "question",
            "question_option",
            "matrix_row",
            "matrix_column",
            "score_definition",
            "interpretation_band",
          ].indexOf(b.table),
      )) {
        await db.query(
          `INSERT INTO instrument.${n.table}(id,scope_id,version_id,stable_key,position,parent_id,payload) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            n.payload.id,
            scope,
            vid,
            n.payload.key,
            n.position,
            n.parentId,
            n.payload,
          ],
        );
      }
      await db.query(
        "UPDATE instrument.questionnaire_version SET state='PUBLISHED',schema_hash=$2,published_at=clock_timestamp() WHERE id=$1",
        [vid, createHash("sha256").update(canonicalJson(d)).digest()],
      );
    }
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    await db.end();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (!process.env.MIGRATION_DATABASE_URL) throw Error();
    await seedInstruments(process.env.MIGRATION_DATABASE_URL);
    console.log("Illustrative templates available.");
  } catch {
    console.error(
      "Template seed failed; inspect through the operator channel.",
    );
    process.exitCode = 1;
  }
}
