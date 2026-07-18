function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 8080),

  oidcIssuer: required("OIDC_ISSUER"),
  oidcClientId: required("OIDC_CLIENT_ID"),
  oidcClientSecret: required("OIDC_CLIENT_SECRET"),
  oidcRedirectUri: required("OIDC_REDIRECT_URI"),
  requiredGroup: process.env.REQUIRED_GROUP ?? "grp-admin",

  sessionSecret: required("SESSION_SECRET"),
  sessionDurationHours: Number(process.env.SESSION_DURATION_HOURS ?? 4),
  csrfSecret: required("CSRF_SECRET"),

  litellmUrl: process.env.LITELLM_URL ?? "http://litellm.llm-core:4000",
  litellmMasterKey: required("LITELLM_MASTER_KEY"),

  authentikUrl: process.env.AUTHENTIK_URL ?? "http://authentik-server.llm-platform:9000",
  authentikToken: required("AUTHENTIK_TOKEN"),

  openwebuiUrl: process.env.OPENWEBUI_URL ?? "http://open-webui.llm-core:8080",
  openwebuiAdminKey: required("OPENWEBUI_ADMIN_KEY"),
};
