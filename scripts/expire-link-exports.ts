import { cleanLocalExports } from "../src/link-storage";
try {
  console.log(
    `Expired local link exports removed: ${await cleanLocalExports()}`,
  );
} catch {
  console.error(
    "Link export cleanup unavailable. Check local storage configuration.",
  );
  process.exitCode = 1;
}
