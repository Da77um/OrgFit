import { createServer, type Server, type Socket } from "node:net";

// ---------------------------------------------------------------------------
// A clamd PROTOCOL TEST DOUBLE. It is not ClamAV and scans nothing: it speaks
// the documented zVERSION / zINSTREAM framing (NUL-terminated command, 4-byte
// big-endian chunk lengths, a zero-length chunk to end), reassembles the
// stream, and answers FOUND only for the harmless EICAR test string. Every
// test that uses it is a MOCKED-ADAPTER test and says so; a real-engine test
// needs ORGFIT_TEST_CLAMD_ADDRESS and a running clamd.
// ---------------------------------------------------------------------------

export type ClamdMode = "normal" | "hang" | "size-limit" | "garbage" | "close-mid-stream";

export const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export async function startClamdDouble(initial: ClamdMode = "normal") {
  let mode: ClamdMode = initial;
  const received: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let command: string | null = null;
    const chunks: Buffer[] = [];
    socket.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (command === null) {
        const nul = buffer.indexOf(0);
        if (nul < 0) return;
        command = buffer.subarray(0, nul).toString("latin1");
        buffer = buffer.subarray(nul + 1);
        if (command === "zVERSION") {
          socket.end("ClamAV 1.4.1/27400/Tue Sep 15 08:00:00 2026\0");
          return;
        }
        if (command !== "zINSTREAM") {
          socket.end("UNKNOWN COMMAND\0");
          return;
        }
      }
      if (command !== "zINSTREAM") return;
      if (mode === "close-mid-stream" && buffer.length > 0) {
        socket.destroy();
        return;
      }
      for (;;) {
        if (buffer.length < 4) return;
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          buffer = buffer.subarray(4);
          const stream = Buffer.concat(chunks);
          received.push(stream);
          if (mode === "hang") return; // never answers
          if (mode === "size-limit") return void socket.end("INSTREAM size limit exceeded. ERROR\0");
          if (mode === "garbage") return void socket.end("something unexpected\0");
          return void socket.end(
            stream.toString("latin1").includes(EICAR) ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0",
          );
        }
        if (buffer.length < 4 + size) return;
        chunks.push(Buffer.from(buffer.subarray(4, 4 + size)));
        buffer = buffer.subarray(4 + size);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    address: `tcp://127.0.0.1:${port}`,
    port,
    received,
    setMode: (m: ClamdMode) => {
      mode = m;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
