import { gatewayReadiness } from "../../../../../src/gateway-db";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Readiness for a load balancer: the gateway credential is the least-privileged
// one it must be, and the environment is not a restore awaiting its tombstone
// replay. The body says nothing about which check failed.
export async function GET() {
  try {
    await gatewayReadiness();
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
