import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const item of ['index.html', 'src', 'server.js', 'package.json']) {
  const source = path.join(root, item);
  const target = path.join(dist, item);

  if (!fs.existsSync(source)) {
    throw new Error(`Required asset is missing: ${item}`);
  }

  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.cpSync(source, target, { recursive: true });
  } else {
    fs.copyFileSync(source, target);
  }
}

console.log('Site and online room server copied to dist/');
