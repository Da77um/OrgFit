import { identityAccountUrl } from "../../../../src/config";
import { accountPage } from "../account-page";
import { ProfileScreen } from "./profile-ui";

export default async function ProfilePage() {
  return accountPage({
    section: "profile",
    adminOnly: false,
    load: async (tx, profile) => ({
      // Names of the caller's own assignments, read through row security; a
      // Super Admin's access is all organizations and is said so instead.
      organizations:
        profile.role === "SUPER_ADMIN" || profile.organizationIds.length === 0
          ? []
          : await tx
              .selectFrom("core.organization")
              .select(["id", "code", "name_ar", "name_en"])
              .where("id", "in", profile.organizationIds)
              .orderBy("code")
              .limit(100)
              .execute(),
      accountUrl: identityAccountUrl(),
    }),
    render: (profile, data) => <ProfileScreen profile={profile} {...data} />,
  });
}
