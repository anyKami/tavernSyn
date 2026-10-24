// OpenSSH invokes this only for a password prompt. Credentials never enter argv or environment values.
import { readPassword } from '../lib/connection.mjs';

try {
    if (!/password:\s*$/i.test(process.argv[2] ?? '') || !process.env.TAVERNSYN_PASSWORD_FILE) process.exit(1);
    process.stdout.write(`${await readPassword(process.env.TAVERNSYN_PASSWORD_FILE)}\n`);
} catch { process.exitCode = 1; }
