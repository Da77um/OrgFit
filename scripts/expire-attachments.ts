import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  scannerPool,
  scannerReadiness,
  closeScannerPool,
} from "../src/scanner-db";
import {
  deleteAttachment,
  cleanLocalAttachments,
  ATTACHMENT_ORPHAN_HOURS,
} from "../src/attachment-storage";

// Attachment retention. The row is the authority: core.expire_attachments
// retires every clean attachment past its retention date, plus rejected, failed
// and never-completed uploads older than the orphan window, and hands back the
// storage keys it just retired. Those objects are then deleted. The row itself
// survives as EXPIRED audit metadata — what was uploaded, by whom and when
// remains answerable after the content is gone.
//
// The local sweep is a development convenience for bytes whose row never
// existed. In a bucket that belongs to a lifecycle rule on attachments/.
export async function expireAttachments(limit = 100) {
  await scannerReadiness();
  try {
    const { rows } = await scannerPool().query<{
      data: { id: string; organizationId: string; storageKey: string | null }[];
    }>("SELECT core.expire_attachments($1,$2::interval) AS data", [
      limit,
      `${ATTACHMENT_ORPHAN_HOURS} hours`,
    ]);
    let removed = 0;
    for (const row of rows[0].data) {
      await deleteAttachment(row.organizationId, row.id);
      removed++;
    }
    return removed;
  } finally {
    await closeScannerPool();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const expired = await expireAttachments();
    const orphans = process.env.ATTACHMENT_S3_BUCKET
      ? 0
      : await cleanLocalAttachments();
    console.log(
      `Expired attachments removed: ${expired}; orphans removed: ${orphans}`,
    );
  } catch {
    console.error(
      "Attachment cleanup unavailable. Check the scanner credential and attachment storage configuration.",
    );
    process.exitCode = 1;
  }
}
