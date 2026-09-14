import {
  anonymousOperatorUrl,
  markRestorePending,
  operatorUrl,
  reapplyTombstones,
} from "../src/operations";
import { assertProcessEnvironment, guardMessage } from "../src/runtime-guard";

// Run against a RESTORED environment before any application is pointed at it.
//   --mark     only set REAPPLY_PENDING (first step after the database starts)
//   --open-despite-incidents   open even if an unrecoverable payload was found
try {
  assertProcessEnvironment("operator");
  const dir = process.env.TOMBSTONE_LEDGER_DIRECTORY;
  if (!dir) throw new Error("TOMBSTONE_LEDGER_DIRECTORY required");
  if (process.argv.includes("--mark")) {
    await markRestorePending(operatorUrl());
    console.log("Restore gate set: REAPPLY_PENDING.");
  } else {
    const report = await reapplyTombstones(operatorUrl(), anonymousOperatorUrl(), dir, {
      openDespiteIncidents: process.argv.includes("--open-despite-incidents"),
    });
    console.log(JSON.stringify(report));
    if (!report.opened) process.exitCode = 2;
  }
} catch (e) {
  console.error(guardMessage(e) ?? "Restore replay failed. The environment remains closed.");
  process.exitCode = 1;
}
