// Lambda の入口。EventBridge から { site: 'feed' } のように呼ばれ、その取り込み口を1ページ進める。
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { tick } from './tick.mjs';
import { SITES } from './sites/index.mjs';
import { createDynamoStore } from './lib/store.mjs';
import { loadConfig } from './config.mjs';

// 温まった Lambda が古い値（登録前の空など）を持ち続けないよう、5分で読み直す
let secrets;
let loadedAt = 0;
async function loadSecrets() {
  if (secrets && Date.now() - loadedAt < 5 * 60_000) return secrets;
  if (!process.env.SECRET_ID) return (secrets = {});
  const r = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ID }));
  loadedAt = Date.now();
  return (secrets = JSON.parse(r.SecretString || '{}'));
}

export async function crawl(event) {
  const mod = SITES[event.site];
  if (!mod) throw new Error(`unknown site: ${event.site}`);
  const store = await createDynamoStore(process.env.TABLE_NAME);
  return tick({ mod, store, config: loadConfig(), secrets: await loadSecrets(), log: console.log });
}
