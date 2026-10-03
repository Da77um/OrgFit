import { respondentAr } from "../../../src/respondent-i18n";
import { Alert } from "../../../src/ui";
import { Lockup } from "../../../src/brand";
// The bare origin carries no invitation context and must not hint at one.
export default function Entry() {
  return (
    <main id="main" className="wrap">
      <section className="panel login stack">
        <span className="state-lockup" aria-hidden="true">
          <Lockup descriptor="التقييم التنظيمي" markSize={56} cap={18} />
        </span>
        <h1>{respondentAr.appTitle}</h1>
        <Alert tone="warning" role="status">
          {respondentAr.unavailable}
        </Alert>
      </section>
    </main>
  );
}
