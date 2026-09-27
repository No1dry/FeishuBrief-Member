import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engine = path.resolve(root, "../FeishuBrief-next");
const files = [
  ["lib/research/personal-contract.ts", "personal-contract.ts"],
  ["lib/research/personal.ts", "personal.ts"],
  ["lib/research/radar-contract.ts", "radar-contract.ts"],
  ["lib/research/member-export-contract.ts", "member-export-contract.ts"],
];
const manifest = { protocol: "member-engine-v1", files: {} };
const checking = process.argv.includes("--check");
fs.mkdirSync(path.join(root, "src/engine"), { recursive: true });
for (const [source, target] of files) {
  const text = fs.readFileSync(path.join(engine, source), "utf8").replace(/\r\n/g, "\n");
  manifest.files[target] = { source, sha256: createHash("sha256").update(text).digest("hex") };
  const destination = path.join(root, "src/engine", target);
  if (checking) {
    if (fs.readFileSync(destination, "utf8").replace(/\r\n/g, "\n") !== text) throw new Error(`Engine contract drift: ${target}`);
  } else fs.writeFileSync(destination, text);
}
const destination = path.join(root, "src/engine/manifest.json");
const expected = `${JSON.stringify(manifest, null, 2)}\n`;
if (checking) {
  if (fs.readFileSync(destination, "utf8").replace(/\r\n/g, "\n") !== expected) throw new Error("Engine manifest drift");
} else fs.writeFileSync(destination, expected);
console.log(`Engine contracts ${checking ? "verified" : "synchronized"} (${files.length} files)`);
