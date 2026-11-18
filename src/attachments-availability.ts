// Visit attachments are off (D-195, owner's choice) where they cannot work: a
// production deployment with no attachment bucket has nowhere to keep the file
// and no malware scanner to release it (P-010). Development keeps them on.
export function attachmentsAvailable(env: Record<string, string | undefined> = process.env) {
  return env.NODE_ENV !== "production" || !!env.ATTACHMENT_S3_BUCKET;
}
