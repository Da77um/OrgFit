import { cookies } from "next/headers";
import { localeOf } from "../../../../src/i18n";
import { OrganizationLoading } from "../loading-ui";

export default async function Loading() {
  const locale = localeOf((await cookies()).get("orgfit-locale")?.value);
  return <OrganizationLoading locale={locale} />;
}
