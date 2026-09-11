import { respondentAr } from "../../../src/respondent-i18n";
import { Alert, Mark } from "../../../src/ui";
// The bare origin carries no invitation context and must not hint at one.
export default function Entry() {
  return (
    <main id="main" className="wrap">
      <section className="panel login stack">
        <Mark className="state-mark" />
        <h1>{respondentAr.appTitle}</h1>
        <Alert tone="warning" role="status">
          {respondentAr.unavailable}
        </Alert>
      </section>
    </main>
  );
}
