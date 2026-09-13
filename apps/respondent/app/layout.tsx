import "../../../src/theme.css";
export const viewport = {
  width: "device-width",
  initialScale: 1,
  // The virtual keyboard shrinks the layout viewport instead of overlaying it,
  // so a focused field and the action bar are laid out in the space that is
  // actually visible. Zoom is never restricted.
  interactiveWidget: "resizes-content" as const,
};
export const metadata = {
  title: "OrgFit",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
