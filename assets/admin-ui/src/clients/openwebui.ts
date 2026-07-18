import { config } from "../config.js";
import { UpstreamError } from "./errors.js";

const SERVICE = "Open WebUI";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.openwebuiUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openwebuiAdminKey}`,
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

export interface OpenWebUiUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user" | "pending";
}

export async function listUsers(): Promise<OpenWebUiUser[]> {
  const data = await call<OpenWebUiUser[] | { users: OpenWebUiUser[] }>("/api/v1/users/");
  return Array.isArray(data) ? data : (data.users ?? []);
}

export async function updateUserRole(id: string, role: "admin" | "user" | "pending"): Promise<void> {
  await call<void>(`/api/v1/users/${id}/update`, {
    method: "POST",
    body: JSON.stringify({ role }),
  });
}

export async function deleteUser(id: string): Promise<void> {
  await call<void>(`/api/v1/users/${id}`, { method: "DELETE" });
}

// Not wired to any route in v1 — accounts self-provision via trusted-header
// SSO on first login (see friends.ts "Add UI friend"). Kept for future use.
export async function adminCreateUser(params: {
  email: string;
  password: string;
  name: string;
}): Promise<OpenWebUiUser> {
  return call<OpenWebUiUser>("/api/v1/auths/add", {
    method: "POST",
    body: JSON.stringify({ email: params.email, password: params.password, name: params.name, role: "user" }),
  });
}
