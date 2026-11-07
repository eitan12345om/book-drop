// Prints the converter versions pinned in the Dockerfile (or the file given as the first
// argument) as JSON, for .github/workflows/converter-updates.yml.
import fs from 'fs';

const TOOLS = [
  {
    name: 'kepubify',
    repo: 'pgaskin/kepubify',
    pattern: /github\.com\/pgaskin\/kepubify\/v\d+\/cmd\/kepubify@v(\S+)/,
  },
];

const dockerfile = fs.readFileSync(
  process.argv[2] ?? new URL('../Dockerfile', import.meta.url),
  'utf8'
);

const pins = [];
for (const { name, repo, pattern } of TOOLS) {
  const pinned = pattern.exec(dockerfile)?.[1];
  if (!pinned) {
    console.error(`No ${name} version found in the Dockerfile`);
    process.exit(1);
  }
  pins.push({ name, repo, pinned });
}
console.log(JSON.stringify(pins));
