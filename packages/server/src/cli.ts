/**
 * Operator commands, run on the server itself.
 *
 * There is no mail service, so there is no self-service password reset — this
 * is the thing the landing page means by "the operator can set a new one on the
 * server". It talks to the same storage the server does, so it must run with
 * the same PLAYGROUND_DB (inside the container, for a Docker deployment).
 *
 *   node --experimental-strip-types --experimental-sqlite \
 *     packages/server/src/cli.ts set-password someone@example.com 'new password'
 *   … cli.ts list-users
 *   … cli.ts make-owner someone@example.com doc_abc123
 */

import { persistence } from './persistence.ts';
import { grant, setPassword } from './accounts.ts';

const [command, ...args] = process.argv.slice(2);

const usage = `commands:
  set-password <email> <password>   set a password and end that person's sessions
  list-users                        every account on this instance
  make-owner <email> <docId>        give someone ownership of a document`;

try {
  switch (command) {
    case 'set-password': {
      const [email, password] = args;
      if (!email || !password) throw new Error('set-password needs an email and a password');
      await setPassword(email, password);
      console.log(`Password set for ${email}. Existing sessions were signed out.`);
      break;
    }
    case 'list-users': {
      const users = await (await persistence()).listUsers();
      if (!users.length) console.log('No accounts yet.');
      for (const u of users) {
        console.log(`${u.email.padEnd(32)} ${u.name.padEnd(20)} ${new Date(u.createdAt).toISOString().slice(0, 10)}`);
      }
      break;
    }
    case 'make-owner': {
      const [email, docId] = args;
      if (!email || !docId) throw new Error('make-owner needs an email and a document id');
      const user = await (await persistence()).loadUserByEmail(email.trim().toLowerCase());
      if (!user) throw new Error(`no account for ${email}`);
      await grant(docId, user.id, 'owner');
      console.log(`${email} now owns ${docId}.`);
      break;
    }
    default:
      console.log(usage);
      process.exit(command ? 1 : 0);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
