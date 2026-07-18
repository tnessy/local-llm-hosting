import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { sessionMiddleware } from "./auth/session.js";
import { requireAuth, requireAdminGroup } from "./auth/middleware.js";
import { doubleCsrfProtection, generateCsrfToken } from "./auth/csrf.js";
import { authRouter } from "./routes/auth.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { keysRouter } from "./routes/keys.js";
import { authentikUsersRouter } from "./routes/users-authentik.js";
import { openwebuiUsersRouter } from "./routes/users-openwebui.js";
import { friendsRouter } from "./routes/friends.js";
import { UpstreamError } from "./clients/errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  // Cloudflare Tunnel -> Traefik -> this pod all happens over plain HTTP
  // in-cluster; trust proxy so express-session/csrf-csrf see the real
  // X-Forwarded-Proto (https) rather than treating every request as insecure.
  app.set("trust proxy", 1);
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));

  app.use(helmet());
  app.use(express.static(path.join(__dirname, "public")));
  app.use(express.urlencoded({ extended: false }));

  // Order below is load-bearing: cookie-parser must exist before CSRF (which
  // reads/writes the admin_ui_csrf cookie via req.cookies), session must
  // exist before CSRF (which keys off the session id), CSRF must exist before
  // authRouter (so POST /logout is covered), and requireAuth/requireAdminGroup
  // must come after authRouter (so /login and /callback stay reachable while
  // logged out).
  app.use(cookieParser());
  app.use(sessionMiddleware);
  app.use(doubleCsrfProtection);
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.user = req.session.user;
    res.locals.requiredGroup = config.requiredGroup;
    res.locals.csrfToken = generateCsrfToken(req, res);
    next();
  });

  app.use(authRouter);

  app.use(requireAuth, requireAdminGroup);
  app.use(dashboardRouter);
  app.use(keysRouter);
  app.use(authentikUsersRouter);
  app.use(openwebuiUsersRouter);
  app.use(friendsRouter);

  app.use((_req: Request, res: Response) => {
    res.status(404).render("error", { title: "Not found", message: "Page not found." });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message =
      err instanceof UpstreamError
        ? `${err.service} error: ${err.message}`
        : err instanceof Error
          ? err.message
          : "Unexpected error";
    console.error(JSON.stringify({ error: true, message, stack: err instanceof Error ? err.stack : undefined }));
    res.status(500).render("error", { title: "Something went wrong", message });
  });

  return app;
}
