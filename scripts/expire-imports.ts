import { cleanLocalSources } from "../src/import-storage";
try {
  console.log(
    `Expired local import sources removed: ${await cleanLocalSources()}`,
  );
} catch {
  console.error(
    "Import cleanup unavailable. Check local storage configuration.",
  );
  process.exitCode = 1;
}
