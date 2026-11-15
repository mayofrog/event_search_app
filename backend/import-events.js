const fs = require("node:fs/promises");
const path = require("node:path");

const sourceFile = path.join(__dirname, "import", "events.json");
const outputFile = path.join(__dirname, "data", "events.json");

async function main() {
  const incoming = JSON.parse(await fs.readFile(sourceFile, "utf8"));
  let existing = [];
  try {
    existing = JSON.parse(await fs.readFile(outputFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!Array.isArray(existing)) throw new Error("Existing events.json is not an array.");
  if (!Array.isArray(incoming)) throw new Error("Import data is not an array.");

  const present = new Set(existing.map(event => event.id));
  const additions = incoming.filter(event => !present.has(event.id));
  const all = [...existing, ...additions];
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  const backup = outputFile + ".backup-" + Date.now();
  await fs.writeFile(backup, JSON.stringify(existing, null, 2));
  const temporary = outputFile + ".importing";
  await fs.writeFile(temporary, JSON.stringify(all, null, 2));
  await fs.rename(temporary, outputFile);
  console.log(`Imported ${additions.length} events. Total: ${all.length}.`);
  console.log(`Previous data backed up to ${backup}`);
  console.log("Restart the backend with npm start.");
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
