import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";

const { Server, utils } = ssh2;

const port = Number(process.env.COZYPAD_TEST_SSH_PORT || 22222);
const password = String(process.env.COZYPAD_TEST_SSH_PASSWORD || "fixture-password");
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const authorizedKeys = new Map();

function publicKeyData(line) {
  const parsed = utils.parseKey(String(line || ""));
  if (parsed instanceof Error) return null;
  return parsed.getPublicSSH();
}

function extractQuotedKey(command) {
  const matches = [...String(command).matchAll(/'((?:[^']|'"'"')+cozypad:[^']+)'/g)];
  return matches[0]?.[1]?.replaceAll(`'"'"'`, `'`) || "";
}

const server = new Server({ hostKeys: [privateKey] }, (client) => {
  let username = "";
  client.on("authentication", (context) => {
    username = context.username;
    if (context.method === "password") {
      if (context.password === password) context.accept();
      else context.reject();
      return;
    }
    if (context.method === "publickey" && username !== "verifyfail" && username !== "cleanupfail") {
      const accepted = [...authorizedKeys.values()].some((line) => {
        const data = publicKeyData(line);
        return data?.equals(context.key.data);
      });
      if (accepted) context.accept();
      else context.reject();
      return;
    }
    context.reject();
  });
  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        const command = String(info.command || "");
        if (command.includes("COZYPAD_KEY_READY")) {
          const key = extractQuotedKey(command);
          if (key) authorizedKeys.set(key, key);
          stream.write("COZYPAD_KEY_READY\n");
          stream.exit(key ? 0 : 1);
          stream.end();
          return;
        }
        if (command.includes("COZYPAD_KEY_REMOVED")) {
          if (username === "cleanupfail") {
            stream.stderr.write("fixture cleanup failure\n");
            stream.exit(1);
            stream.end();
            return;
          }
          const key = extractQuotedKey(command);
          authorizedKeys.delete(key);
          stream.write("COZYPAD_KEY_REMOVED\n");
          stream.exit(0);
          stream.end();
          return;
        }
        if (command.includes("COZYPAD_SSH_OK")) {
          stream.write("COZYPAD_SSH_OK\ncozypad-fixture\n/home/fixture\n");
          stream.exit(0);
          stream.end();
          return;
        }
        stream.stderr.write("unsupported fixture command\n");
        stream.exit(1);
        stream.end();
      });
    });
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`[ssh-fixture] READY 127.0.0.1:${port}\n`);
});

function close() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
