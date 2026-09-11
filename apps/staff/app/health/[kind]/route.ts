import { readiness } from "../../../../../src/db";
import { safeError } from "../../../../../src/http";
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ kind: string }> },
) {
  const { kind } = await ctx.params;
  if (kind === "live")
    return Response.json(
      { status: "ok" },
      { headers: { "Cache-Control": "no-store" } },
    );
  if (kind !== "ready") return new Response(null, { status: 404 });
  try {
    await readiness();
    return Response.json(
      { status: "ok" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return safeError(e);
  }
}
