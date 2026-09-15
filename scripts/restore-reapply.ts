import {
  anonymousOperatorUrl,
  markRestorePending,
  operatorUrl,
  reapplyTombstones,
} from "../src/operations";
import { tombstoneSinkFromEnvironment } from "../src/tombstone-ledger";
import { assertProcessEnvironment, guardMessage } from "../src/runtime-guard";

// Run against a RESTORED environment before any application is pointed at it.
//   --mark     only set REAPPLY_PENDING (first step after the database starts)
//   --open-despite-incidents   open even if an unrecoverable payload was found
// The ledger comes from TOMBSTONE_LEDGER_S3_BUCKET or (nonproduction)
// TOMBSTONE_LEDGER_DIRECTORY; a ledger whose seals do not verify is refused and
// the environment stays closed.
try {
  assertProcessEnvironment("operator");
  if (process.argv.includes("--mark")) {
    await markRestorePending(operatorUrl());
    console.log("Restore gate set: REAPPLY_PENDING.");
  } else {
    const core = operatorUrl();
    const anonymous = anonymousOperatorUrl();
    const report = await reapplyTombstones(core, anonymous, tombstoneSinkFromEnvironment(), {
      openDespiteIncidents: process.argv.includes("--open-despite-incidents"),
    });
    console.log(JSON.stringify(report));
    if (!report.opened) process.exitCode = 2;
  }
} catch (e) {
  console.error(guardMessage(e) ?? "Restore replay failed. The environment remains closed.");
  process.exitCode = 1;
}
