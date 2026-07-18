import { createApp } from "./app.js";
import { config } from "./config.js";
import { getOidcConfig } from "./auth/oidc.js";
async function main() {
    // Fail fast: if OIDC discovery is broken, refuse to serve a login page
    // that can never succeed.
    await getOidcConfig();
    const app = createApp();
    app.listen(config.port, () => {
        console.log(JSON.stringify({ msg: `admin-ui listening on :${config.port}` }));
    });
}
main().catch((err) => {
    console.error("admin-ui failed to start:", err);
    process.exit(1);
});
