import { cookies } from "next/headers";
import { localeOf } from "../../../../src/i18n";
import { QuestionnairesLoading } from "../loading-ui";

export default async function Loading() {
  const locale = localeOf((await cookies()).get("orgfit-locale")?.value);
  return <QuestionnairesLoading locale={locale} />;
}
