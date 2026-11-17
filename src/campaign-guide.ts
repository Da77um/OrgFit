import { sql } from "kysely";
import { type Tx, requireAccess } from "./db";
import { AppError, uuid } from "./security";
import { response } from "./http";
import { campaignRead } from "./campaigns";
import { departmentOptions } from "./instruments";

// Read-only data for the guided "send a questionnaire" flow and for the
// screens' next-step explanations (D-189). Nothing here writes, and nothing
// here widens what a staff member may read: every query runs under the staff
// role and its row-level policies, after the same organization and capability
// checks the existing screens use. Where a policy hides rows (the directory
// without directory.manage, campaigns without a campaign capability), the
// answer says "not readable" (null) instead of reporting a misleading zero.

export type UsableVersion = {
  id: string;
  versionNumber: number;
  questionnaireId: string;
  familyKey: string;
  scope: "GLOBAL" | "ORGANIZATION";
  name: { ar: string; en: string };
  title: { ar?: string; en?: string } | null;
  target: { mode: "ORGANIZATION" | "DEPARTMENTS"; departmentIds: string[] };
};
export type DepartmentChoice = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  /** Active participants in the department; null when the directory is not readable. */
  active: number | null;
};
export type CampaignOptions = {
  versions: UsableVersion[];
  departments: DepartmentChoice[];
  /** Active participants in the whole organization; null when not readable. */
  organizationActive: number | null;
  /** Active participants without a department; null when not readable. */
  unassignedActive: number | null;
  directoryReadable: boolean;
  series: { id: string; familyKey: string; nameAr: string; nameEn: string | null; createdAt: string }[];
};

async function canReadDirectory(tx: Tx) {
  const { rows } = await sql<{
    ok: boolean;
  }>`select access.has_capability('directory.manage') ok`.execute(tx);
  return rows[0].ok;
}

// Published versions this organization may run: the global library's and its
// own, exactly the set save_round and save_campaign accept (008). Archived
// questionnaires are left out of the picker; the database rule is unchanged.
export async function usableVersions(tx: Tx, org: string): Promise<UsableVersion[]> {
  const { rows } = await sql<{
    id: string;
    version_number: number;
    organization_id: string | null;
    questionnaire_id: string;
    family_key: string;
    name_ar: string;
    name_en: string;
    title: { ar?: string; en?: string } | null;
    target_mode: "ORGANIZATION" | "DEPARTMENTS";
  }>`select v.id,v.version_number,v.organization_id,q.id questionnaire_id,q.family_key,q.name_ar,q.name_en,v.metadata->'title' title,q.target_mode
     from instrument.questionnaire_version v
     join instrument.questionnaire q on q.scope_id=v.scope_id and q.id=v.questionnaire_id
     where v.state='PUBLISHED' and q.status='ACTIVE' and (v.organization_id is null or v.organization_id=${org}::uuid)
     order by (v.organization_id is null), q.name_ar, q.id, v.version_number desc limit 500`.execute(tx);
  const targeted = rows.filter((r) => r.target_mode === "DEPARTMENTS").map((r) => r.questionnaire_id);
  const departments = new Map<string, string[]>();
  if (targeted.length) {
    const t = await sql<{
      questionnaire_id: string;
      department_id: string;
    }>`select questionnaire_id,department_id from instrument.questionnaire_department where organization_id=${org}::uuid and questionnaire_id=any(${targeted}::uuid[]) order by department_id`.execute(
      tx,
    );
    for (const r of t.rows)
      departments.set(r.questionnaire_id, [...(departments.get(r.questionnaire_id) ?? []), r.department_id]);
  }
  return rows.map((r) => ({
    id: r.id,
    versionNumber: r.version_number,
    questionnaireId: r.questionnaire_id,
    familyKey: r.family_key,
    scope: r.organization_id ? "ORGANIZATION" : "GLOBAL",
    name: { ar: r.name_ar, en: r.name_en },
    title: r.title,
    target: {
      mode: r.target_mode,
      departmentIds: r.target_mode === "DEPARTMENTS" ? (departments.get(r.questionnaire_id) ?? []) : [],
    },
  }));
}

export async function campaignOptions(tx: Tx, org: string): Promise<CampaignOptions> {
  await campaignRead(tx, org);
  const readable = await canReadDirectory(tx);
  const counts = new Map<string | null, number>();
  let total: number | null = null;
  if (readable) {
    const c = await sql<{
      department_id: string | null;
      n: number;
    }>`select department_id,count(*)::int n from core.participant where organization_id=${org}::uuid and status='ACTIVE' group by department_id`.execute(
      tx,
    );
    total = 0;
    for (const r of c.rows) {
      counts.set(r.department_id, r.n);
      total += r.n;
    }
  }
  const departments = (await departmentOptions(tx, org))
    .filter((d) => d.status === "ACTIVE")
    .map((d) => ({
      id: d.id,
      code: d.code,
      nameAr: d.name_ar,
      nameEn: d.name_en,
      active: readable ? (counts.get(d.id) ?? 0) : null,
    }));
  const series = await sql<{
    id: string;
    questionnaire_family_id: string;
    name_ar: string;
    name_en: string | null;
    created_at: Date;
  }>`select id,questionnaire_family_id,name_ar,name_en,created_at from core.assessment_series where organization_id=${org}::uuid and status='ACTIVE' order by created_at desc,id limit 500`.execute(
    tx,
  );
  return {
    versions: await usableVersions(tx, org),
    departments,
    organizationActive: total,
    unassignedActive: readable ? (counts.get(null) ?? 0) : null,
    directoryReadable: readable,
    series: series.rows.map((s) => ({
      id: s.id,
      familyKey: s.questionnaire_family_id,
      nameAr: s.name_ar,
      nameEn: s.name_en,
      createdAt: new Date(s.created_at).toISOString(),
    })),
  };
}

export type CampaignStatusItem = {
  campaignId: string;
  roundId: string;
  seriesId: string;
  label: string;
  state: string;
  releaseState: string;
};
export type CampaignStatus = {
  departments: number;
  participants: number | null;
  publishedQuestionnaires: number;
  campaigns: number | null;
  linksIssued: number | null;
  responses: number | null;
  items: CampaignStatusItem[] | null;
};

// Aggregate counts for the overview checklist and the results/history
// explanations. Completion is already live on every campaign screen; these
// are organization totals of the same numbers, never per person.
export async function campaignStatus(tx: Tx, org: string): Promise<CampaignStatus> {
  await requireAccess(tx, org);
  const readable = await canReadDirectory(tx);
  const campaignsReadable = (
    await sql<{ ok: boolean }>`select core.campaign_readable(${org}::uuid) ok`.execute(tx)
  ).rows[0].ok;
  const participationReadable = (
    await sql<{
      ok: boolean;
    }>`select access.has_capability('campaigns.manage') or access.has_capability('participation.read') ok`.execute(tx)
  ).rows[0].ok;
  const departments = (await departmentOptions(tx, org)).filter((d) => d.status === "ACTIVE").length;
  const participants = readable
    ? (
        await sql<{
          n: number;
        }>`select count(*)::int n from core.participant where organization_id=${org}::uuid and status='ACTIVE'`.execute(tx)
      ).rows[0].n
    : null;
  const published = (await usableVersions(tx, org)).length;
  let items: CampaignStatusItem[] | null = null;
  if (campaignsReadable) {
    const r = await sql<{
      campaign_id: string;
      round_id: string;
      series_id: string;
      label: string;
      state: string;
      release_state: string;
    }>`select c.id campaign_id,r.id round_id,r.series_id,r.label,core.effective_state(c.state,c.starts_at,c.ends_at) state,c.release_state
       from core.campaign c join core.assessment_round r on r.organization_id=c.organization_id and r.id=c.round_id
       where c.organization_id=${org}::uuid order by c.starts_at desc,c.id limit 100`.execute(tx);
    items = r.rows.map((x) => ({
      campaignId: x.campaign_id,
      roundId: x.round_id,
      seriesId: x.series_id,
      label: x.label,
      state: x.state,
      releaseState: x.release_state,
    }));
  }
  let linksIssued: number | null = null,
    responses: number | null = null;
  if (participationReadable && campaignsReadable) {
    const i = await sql<{
      issued: number;
      completed: number;
    }>`select count(*) filter (where token_generation>0)::int issued,count(*) filter (where status='COMPLETED')::int completed from core.invitation where organization_id=${org}::uuid`.execute(
      tx,
    );
    linksIssued = i.rows[0].issued;
    responses = i.rows[0].completed;
  }
  return {
    departments,
    participants,
    publishedQuestionnaires: published,
    campaigns: items ? items.length : null,
    linksIssued,
    responses,
    items,
  };
}

const guidePath = /^organizations\/([^/]+)\/(campaign-options|campaign-status)$/;
export async function campaignGuideRoute(
  req: Request,
  path: string,
  tx: Tx,
): Promise<Response | null> {
  const match = path.match(guidePath);
  if (!match) return null;
  if (req.method !== "GET") throw new AppError("NOT_FOUND", 404);
  const org = uuid.parse(match[1]);
  return response(
    match[2] === "campaign-options" ? await campaignOptions(tx, org) : await campaignStatus(tx, org),
  );
}
