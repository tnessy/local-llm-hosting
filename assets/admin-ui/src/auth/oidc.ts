import * as client from "openid-client";
import type { Request } from "express";
import { config } from "../config.js";

let oidcConfig: client.Configuration | undefined;

export async function getOidcConfig(): Promise<client.Configuration> {
  if (!oidcConfig) {
    oidcConfig = await client.discovery(
      new URL(config.oidcIssuer),
      config.oidcClientId,
      config.oidcClientSecret,
    );
  }
  return oidcConfig;
}

export async function buildAuthorizationUrl(req: Request, returnTo: string): Promise<string> {
  const cfg = await getOidcConfig();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  req.session.oidc = { state, codeVerifier, returnTo };

  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: config.oidcRedirectUri,
    scope: "openid profile email",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return url.href;
}

export interface OidcUser {
  sub: string;
  email: string;
  groups: string[];
}

export async function handleCallback(req: Request): Promise<OidcUser> {
  const cfg = await getOidcConfig();
  const oidcSession = req.session.oidc;
  if (!oidcSession) {
    throw new Error("No OIDC state in session — login flow was not initiated correctly");
  }

  // req.originalUrl is path+query (e.g. "/callback?code=...&state=...");
  // resolving it against oidcRedirectUri reproduces the exact URL Authentik
  // redirected back to, which is what authorizationCodeGrant validates against.
  const currentUrl = new URL(req.originalUrl, config.oidcRedirectUri);

  const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
    pkceCodeVerifier: oidcSession.codeVerifier,
    expectedState: oidcSession.state,
  });
  const claims = tokens.claims();
  if (!claims) {
    throw new Error("ID token missing claims");
  }
  const groups = Array.isArray(claims.groups) ? (claims.groups as string[]) : [];
  return {
    sub: String(claims.sub),
    email: typeof claims.email === "string" ? claims.email : "",
    groups,
  };
}
