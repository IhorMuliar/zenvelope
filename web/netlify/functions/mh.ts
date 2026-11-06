/**
 * Proxy for the MultiHopper API: /api/mh/* -> ${MH_BASE_URL}/api/v1/* (allowlisted).
 * Env (names only): MH_BASE_URL, MH_API_KEY, MH_ALLOWED_MINTS, SITE_ORIGINS.
 * Logic and rules live in ./_lib/mhProxy.ts.
 */
import { handleMh } from "./_lib/mhProxy.ts";

export default async (req: Request, context: { ip?: string }): Promise<Response> =>
  handleMh(req, {
    env: process.env,
    ip: context?.ip ?? req.headers.get("x-nf-client-connection-ip") ?? undefined,
  });

export const config = { path: "/api/mh/*" };
