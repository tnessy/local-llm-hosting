import { config } from "../config.js";
import { UpstreamError } from "./errors.js";

const SERVICE = "Authentik";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.authentikUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.authentikToken}`,
        ...init.headers,
      },
    });
  } catch (err) {
    throw new UpstreamError(SERVICE, undefined, `network error calling ${path}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new UpstreamError(SERVICE, res.status, `${path} -> ${res.status} ${await res.text()}`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export interface AuthentikUser {
  pk: number;
  username: string;
  email: string;
  name: string;
  is_active: boolean;
  groups_obj?: { name: string }[];
}

export async function listUsers(): Promise<AuthentikUser[]> {
  const data = await call<{ results: AuthentikUser[] }>("/api/v3/core/users/?page_size=200");
  return data.results ?? [];
}

export async function createUser(params: {
  username: string;
  email: string;
  name: string;
}): Promise<AuthentikUser> {
  return call<AuthentikUser>("/api/v3/core/users/", {
    method: "POST",
    body: JSON.stringify({
      username: params.username,
      email: params.email,
      name: params.name,
      is_active: true,
    }),
  });
}

const groupUuidCache = new Map<string, { uuid: string; cachedAt: number }>();
const GROUP_CACHE_TTL_MS = 60 * 60 * 1000;

async function groupUuid(name: string): Promise<string> {
  const cached = groupUuidCache.get(name);
  if (cached && Date.now() - cached.cachedAt < GROUP_CACHE_TTL_MS) {
    return cached.uuid;
  }
  const data = await call<{ results: { pk: string; name: string }[] }>(
    `/api/v3/core/groups/?name=${encodeURIComponent(name)}`,
  );
  const group = data.results?.[0];
  if (!group) {
    throw new UpstreamError(SERVICE, undefined, `Authentik group "${name}" does not exist`);
  }
  groupUuidCache.set(name, { uuid: group.pk, cachedAt: Date.now() });
  return group.pk;
}

export async function addToGroup(userId: number, groupName: string): Promise<void> {
  const uuid = await groupUuid(groupName);
  await call<void>(`/api/v3/core/groups/${uuid}/add_user/`, {
    method: "POST",
    body: JSON.stringify({ pk: userId }),
  });
}

export async function deactivateUser(id: number): Promise<void> {
  await call<void>(`/api/v3/core/users/${id}/`, {
    method: "PATCH",
    body: JSON.stringify({ is_active: false }),
  });
}

// Not wired to any route in v1 — hard delete is intentionally not exposed in
// the UI (destroys the audit-trail-adjacent user record); kept for future/CLI use.
export async function deleteUser(id: number): Promise<void> {
  await call<void>(`/api/v3/core/users/${id}/`, { method: "DELETE" });
}
