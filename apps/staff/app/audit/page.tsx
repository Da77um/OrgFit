import { accountPage } from "../account-page";
import { AuditBrowser } from "./audit-ui";

// Filters arrive in the address so a link ("audit history for this account")
// opens already filtered. Only the allowlisted keys are read; the API validates
// their values and refuses anything else.
const KEYS = ["action", "actorId", "targetId", "organizationId", "from", "to"] as const;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const initial: Record<string, string> = {};
  for (const key of KEYS) {
    const v = raw[key];
    if (typeof v === "string" && v.length <= 100) initial[key] = v;
  }
  return accountPage({
    section: "audit",
    adminOnly: true,
    load: async () => ({ initial }),
    render: (profile, data) => <AuditBrowser profile={profile} initial={data.initial} />,
  });
}
