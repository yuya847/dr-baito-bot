// LINE の入口：Webhook（Lambda の関数 URL）と、定時の通知（EventBridge）。
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createDynamoStore } from './lib/store.mjs';
import { verifySignature, reply, text } from './lib/line.mjs';
import { handleEvent, notify as runNotify } from './assistant.mjs';

let secrets;
let loadedAt = 0;
async function loadSecrets() {
  if (secrets && Date.now() - loadedAt < 5 * 60_000) return secrets;
  const r = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ID }));
  loadedAt = Date.now();
  return (secrets = JSON.parse(r.SecretString || '{}'));
}

export async function webhook(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '', 'utf8');
  const sig = event.headers?.['x-line-signature'];
  const s = await loadSecrets();
  // LINE からの正しい署名がないものは捨てる（関数 URL は誰でも叩けるため）
  if (!verifySignature(s.LINE_CHANNEL_SECRET, raw, sig)) return { statusCode: 401, body: 'bad signature' };
  const body = JSON.parse(raw.toString('utf8') || '{}');
  const store = await createDynamoStore(process.env.TABLE_NAME);
  for (const ev of body.events || []) {
    try {
      await handleEvent(ev, { store, secrets: s });
    } catch (e) {
      console.log('イベント処理に失敗', ev.type, e.message);
      if (ev.replyToken) await reply(s.LINE_CHANNEL_ACCESS_TOKEN, ev.replyToken, [text('うまく処理できませんでした。少し待ってからもう一度送ってください。')]).catch(() => {});
    }
  }
  return { statusCode: 200, body: 'ok' };
}

export async function notify() {
  const store = await createDynamoStore(process.env.TABLE_NAME);
  const r = await runNotify({ store, secrets: await loadSecrets() });
  console.log('notify', JSON.stringify(r));
  return r;
}
