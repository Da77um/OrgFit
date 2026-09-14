// Phase 15 — populated state written by a PREVIOUS release's own code.
//
// tests/release.test.ts copies this file into a git worktree of the baseline
// commit and runs it there, so every row below is produced by that release's
// migrations, routines, gateway, processor and publication job — not by the
// candidate. It prints one JSON line the candidate's upgrade test reads.
//
// State left behind (synthetic, one organization):
//   A  six invitations accepted, closed, processed and published;
//   B  six invitations, three accepted, three links issued but unused, open.
import { respondentFixture } from "../respondent-fixture";
import { exchange, instrument, finalize } from "../../src/respondent";
import { processCampaign } from "../../src/processor";
import { releaseCampaign } from "../../src/publication";
import pg from "pg";

function answersFor(d: { sections: { questions: { id: string; type: string; options: { id: string }[]; rows: { id: string }[]; columns: { id: string }[] }[] }[] }) {
  const out: Record<string, string | string[]> = {};
  for (const q of d.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    if (q.type === "CHECKBOXES") out[q.id] = [q.options[0].id];
    else if (q.type === "MATRIX") for (const r of q.rows) out[r.id] = q.columns[0].id;
    else if (["MULTIPLE_CHOICE", "DROPDOWN", "YES_NO"].includes(q.type)) out[q.id] = q.options[0].id;
    else if (q.type === "RATING_5") out[q.id] = "4";
    else if (q.type === "RATING_10") out[q.id] = "7";
    else if (q.type === "NUMBER") out[q.id] = "4";
    else if (q.type === "DATE") out[q.id] = "2026-06-15";
    else out[q.id] = "نص";
  }
  return out;
}

const f = await respondentFixture(6);
const submit = async (token: string) => {
  const s = await exchange(token);
  await finalize(s.session!, { answers: answersFor((await instrument(s.session!)).document as never) });
};

const A = await f.launchedCampaign();
const aLinks = await f.issueLinks(A.campaignId);
for (const l of aLinks) await submit(l.token);
await f.closeCampaign(A.campaignId);
const core = new pg.Pool({ connectionString: f.fixture.url("orgfit_processor"), max: 2 });
const anon = new pg.Pool({ connectionString: f.fixture.anonymousUrl("orgfit_processor"), max: 2 });
const processed = await processCampaign(core, anon, A.campaignId);
const released = await releaseCampaign(core, anon, A.campaignId);
await core.end();
await anon.end();

const B = await f.launchedCampaign();
const bLinks = await f.issueLinks(B.campaignId);
for (const l of bLinks.slice(0, 3)) await submit(l.token);

const custodianPublicKey = process.env.CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY;
await f.close();
console.log(
  "BASELINE_STATE " +
    JSON.stringify({
      core: f.fixture.name,
      anonymous: f.fixture.anonymousName,
      orgA: f.orgA,
      custodyDirectory: f.custodyDirectory,
      custodianSecret: f.custodianSecret,
      custodianPublicKey,
      A: { campaignId: A.campaignId, roundId: A.roundId, tokens: aLinks.map((l) => l.token), processed: processed.processedCount, released: (released as { state: string }).state },
      B: { campaignId: B.campaignId, used: bLinks.slice(0, 3).map((l) => l.token), unused: bLinks.slice(3).map((l) => l.token) },
    }),
);
process.exit(0);
