import { notFound } from "next/navigation";
import { sql } from "kysely";
import { readConfig } from "../../../../../src/config";
import { uuid } from "../../../../../src/security";
import { accountPage } from "../../account-page";
import { StaffAdmin, StaffRecordView } from "../staff-ui";

export default async function StaffPage({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const { path = [] } = await params;
  if (path.length > 1 || (path[0] && !uuid.safeParse(path[0]).success)) notFound();
  return accountPage({
    section: "staff",
    adminOnly: true,
    load: async (tx) => {
      const local = await sql<{ on: boolean }>`select access.local_access_enabled() as on`.execute(tx);
      const settings = await sql<{
        data: { staffInvitationHours: number };
      }>`select access.settings() as data`.execute(tx);
      return {
        localAccessEnabled: local.rows[0].on,
        invitationHours: settings.rows[0].data.staffInvitationHours,
        // The issuer is a public identifier; the client secret never leaves
        // the server and is not part of this object.
        issuer: readConfig().OIDC_ISSUER,
        production: process.env.NODE_ENV === "production",
      };
    },
    render: (profile, data) =>
      path[0] ? (
        <StaffRecordView key={path[0]} profile={profile} id={path[0]} />
      ) : (
        <StaffAdmin profile={profile} {...data} />
      ),
  });
}
