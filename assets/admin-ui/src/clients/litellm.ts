import { config } from "../config.js";
import { UpstreamError } from "./errors.js";

const SERVICE = "LiteLLM";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.litellmUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.litellmMasterKey}`,
        ...init.headers,
      },
    });
  } catch (err) {
    throw new UpstreamError(SERVICE, undefined, `network error calling ${path}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new UpstreamError(SERVICE, res.status, `${path} -> ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export interface LiteLlmKey {
  // NOTE: field names here follow LiteLLM's documented /key/list shape as of
  // this writing — verify against the live response on first deploy (see
  // 16-admin-ui.md Verification) before trusting the revoke flow in prod.
  token?: string;
  key_name?: string;
  key_alias?: string;
  spend: number;
  max_budget: number | null;
  rpm_limit: number | null;
  models: string[];
}

export async function listKeys(): Promise<LiteLlmKey[]> {
  const data = await call<{ keys: LiteLlmKey[] }>("/key/list");
  return data.keys ?? [];
}

export async function generateKey(params: {
  alias: string;
  models: string[];
  maxBudget?: number;
  budgetDuration?: string;
  rpmLimit?: number;
}): Promise<{ key: string }> {
  return call<{ key: string }>("/key/generate", {
    method: "POST",
    body: JSON.stringify({
      key_alias: params.alias,
      models: params.models,
      max_budget: params.maxBudget,
      budget_duration: params.budgetDuration,
      rpm_limit: params.rpmLimit,
    }),
  });
}

export async function deleteKey(key: string): Promise<void> {
  await call<void>("/key/delete", { method: "POST", body: JSON.stringify({ keys: [key] }) });
}

export async function keyInfo(key: string): Promise<LiteLlmKey> {
  return call<LiteLlmKey>(`/key/info?key=${encodeURIComponent(key)}`);
}
