import { loadConfig } from "../src/config";
import { Store } from "../src/db";
import { AuthService } from "../src/auth";
import { createMailer } from "../src/mail";

const email = process.argv[2];
if (!email || process.argv.length > 4) throw new Error("Usage: npm run bootstrap -- <owner-email> [display-name]");
const config = loadConfig();
const store = new Store(config.databasePath);
try {
  const auth = new AuthService(store, { secret: config.secret, origin: config.origin, mail: createMailer(config) });
  const user = auth.bootstrapOwner(email, process.argv[3] || "课题组管理员");
  console.log(JSON.stringify({ userId: user.userId, role: user.role, loginRequired: true, emailSent: false }));
} finally { store.close(); }
