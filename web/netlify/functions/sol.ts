/**
 * Solana JSON-RPC relay: POST /api/sol -> ${SOLANA_RPC_URL}, seven read/send methods only.
 * Env (names only): SOLANA_RPC_URL, SITE_ORIGINS.
 * Logic and rules live in ./_lib/mhProxy.ts.
 */
import { handleSol } from "./_lib/mhProxy.ts";

export default async (req: Request, context: { ip?: string }): Promise<Response> =>
  handleSol(req, {
    env: process.env,
    ip: context?.ip ?? req.headers.get("x-nf-client-connection-ip") ?? undefined,
  });

export const config = { path: "/api/sol" };
