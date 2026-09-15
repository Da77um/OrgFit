import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

// ---------------------------------------------------------------------------
// An S3-COMPATIBLE TEST DOUBLE for the tombstone ledger tests. Path-style PUT
// (honouring If-None-Match: * and verifying x-amz-checksum-sha256), GET and
// ListObjectsV2. It records the Object Lock headers it was sent but ENFORCES
// NOTHING: no retention, no versioning, no bucket policy, no authentication.
// It proves what the adapter sends and how it reacts, not how a real bucket
// behaves. Tests that use it are labelled mocked-storage tests.
// ---------------------------------------------------------------------------

export type StoredObject = { body: Buffer; headers: Record<string, string> };

export async function startS3Double() {
  const objects = new Map<string, StoredObject>();
  let failing = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (failing > 0) {
        failing--;
        res.writeHead(503, { "content-type": "application/xml" });
        return void res.end("<Error><Code>ServiceUnavailable</Code><Message>synthetic outage</Message></Error>");
      }
      const url = new URL(req.url ?? "/", "http://s3.double");
      const [, bucket, ...rest] = url.pathname.split("/");
      const key = decodeURIComponent(rest.join("/"));
      const id = `${bucket}/${key}`;
      if (req.method === "PUT") {
        if (req.headers["if-none-match"] === "*" && objects.has(id)) {
          res.writeHead(412, { "content-type": "application/xml" });
          return void res.end("<Error><Code>PreconditionFailed</Code><Message>exists</Message></Error>");
        }
        const body = Buffer.concat(chunks);
        const sent = req.headers["x-amz-checksum-sha256"];
        if (sent && sent !== createHash("sha256").update(body).digest("base64")) {
          res.writeHead(400, { "content-type": "application/xml" });
          return void res.end("<Error><Code>BadDigest</Code><Message>checksum</Message></Error>");
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
        objects.set(id, { body, headers });
        res.writeHead(200, { etag: '"x"' });
        return void res.end();
      }
      if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const keys = [...objects.keys()]
          .filter((k) => k.startsWith(`${bucket}/${prefix}`))
          .map((k) => k.slice(bucket.length + 1))
          .sort();
        res.writeHead(200, { "content-type": "application/xml" });
        return void res.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>` +
            keys.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(`${bucket}/${k}`)!.body.length}</Size></Contents>`).join("") +
            "</ListBucketResult>",
        );
      }
      if (req.method === "GET") {
        const found = objects.get(id);
        if (!found) {
          res.writeHead(404, { "content-type": "application/xml" });
          return void res.end("<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>");
        }
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(found.body.length) });
        return void res.end(found.body);
      }
      res.writeHead(405);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    failNext: (n: number) => {
      failing = n;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
