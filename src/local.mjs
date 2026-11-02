// 手元での動作確認：node src/local.mjs [feed] [回数]
// AWS を使わず data/local.json に保存する。設定は .env（JOBS_FEED_URL など。無ければ架空の求人を読む）。
import { readFileSync, existsSync } from 'node:fs';
import { tick } from './tick.mjs';
import { SITES } from './sites/index.mjs';
import { createFileStore } from './lib/store.mjs';
import { loadConfig } from './config.mjs';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const [site = 'feed', times = '1'] = process.argv.slice(2);
const store = createFileStore('data/local.json');
const config = loadConfig();

for (let i = 0; i < Number(times); i += 1) {
  const r = await tick({ mod: SITES[site], store, config, secrets: process.env, log: console.log });
  if (r.cycleDone) break;
  if (i + 1 < Number(times)) await new Promise((res) => setTimeout(res, 60_000)); // 本番と同じく間隔を空ける
}
