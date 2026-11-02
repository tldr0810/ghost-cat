export interface AgentCredential {
  rpcUrl: string;
  token: string;
  /** Human-readable agent name, used in error messages. */
  label: string;
}

export interface Env {
  ASSETS: Fetcher;
  /** "production" enforces https-only and no private addresses on the agent URL. */
  ENVIRONMENT?: string;
  /** The Manyfold agent's A2A JSON-RPC endpoint. Secret: npx wrangler secret put MANYFOLD_AGENT_RPC_URL */
  MANYFOLD_AGENT_RPC_URL?: string;
  /** The agent's A2A bearer token. Secret: npx wrangler secret put MANYFOLD_AGENT_TOKEN */
  MANYFOLD_AGENT_TOKEN?: string;
  /** Optional display name for error messages. */
  MANYFOLD_AGENT_LABEL?: string;
  /** How long one generated set of lines is reused, in seconds. Each new set bills one agent turn. */
  LINES_CACHE_SECONDS?: string;
}
