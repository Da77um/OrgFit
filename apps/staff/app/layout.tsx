import { cookies } from "next/headers";
import { direction, localeOf, messages } from "../../../src/i18n";
import "../../../src/theme.css";
export const metadata = {
  title: "OrgFit",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = localeOf((await cookies()).get("orgfit-locale")?.value),
    m = messages(locale);
  return (
    <html lang={locale} dir={direction(locale)}>
      <body>
        <a className="skip" href="#main">
          {m.skip}
        </a>
        {children}
      </body>
    </html>
  );
}
