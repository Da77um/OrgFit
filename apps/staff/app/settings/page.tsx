import { accountPage } from "../account-page";
import { SettingsScreen } from "./settings-ui";

export default async function SettingsPage() {
  return accountPage({
    section: "settings",
    adminOnly: true,
    load: async () => ({}),
    render: (profile) => <SettingsScreen profile={profile} />,
  });
}
