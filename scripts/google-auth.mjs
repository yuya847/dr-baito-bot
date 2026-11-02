// Google カレンダーの読み取り許可を取り、自分の AWS の Secrets Manager に保存する（画面には表示しない）。
// 本人が1回だけ実行する。ブラウザで Google の同意画面が開くので「許可」を押す。
//   使い方: node scripts/google-auth.mjs [client_secret_*.json のパス]（省略時は ~/Downloads の最新）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const REGION = 'ap-northeast-1';
// 運営者が用意した Google のアプリ（デスクトップ用クライアント）で許可する。Gmail は「制限付き」で毎年の外部診断が要るので求めない
// calendar.events = 予定の書き込み（本人が確認して「追加する」を押したときだけ使う）
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'];

function findClientFile() {
  if (process.argv[2]) return process.argv[2];
  const dir = path.join(os.homedir(), 'Downloads');
  const hits = readdirSync(dir).filter((f) => /^client_secret_.*\.json$/.test(f))
    .map((f) => path.join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!hits.length) throw new Error('~/Downloads に client_secret_*.json が見つかりません');
  return hits[0];
}

const client = JSON.parse(readFileSync(findClientFile(), 'utf8')).installed;
if (!client) throw new Error('デスクトップ アプリ用のクライアントではありません（"installed" がない）');

const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(16).toString('hex');

// 127.0.0.1 の空きポートで Google からの戻りを1回だけ受ける
const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (!u.searchParams.has('code') && !u.searchParams.has('error')) { res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<p style="font:16px sans-serif">完了しました。このタブは閉じてかまいません。</p>');
    server.close();
    if (u.searchParams.get('state') !== state) reject(new Error('state が一致しません'));
    else if (u.searchParams.get('error')) reject(new Error(`許可されませんでした: ${u.searchParams.get('error')}`));
    else resolve(u.searchParams.get('code'));
  }).listen(0, '127.0.0.1', () => {
    const redirect = `http://127.0.0.1:${server.address().port}`;
    server.redirect = redirect;
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({
      client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '),
      access_type: 'offline', prompt: 'consent', state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    });
    console.log('ブラウザで Google の画面を開きます。カレンダーの「読み取り」と「予定の追加」を許可してください。');
    execFile('open', ['-a', 'Google Chrome', auth.toString()]);
  });
  globalThis.__server = server;
});

const r = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  body: new URLSearchParams({
    code, client_id: client.client_id, client_secret: client.client_secret,
    redirect_uri: globalThis.__server.redirect, grant_type: 'authorization_code', code_verifier: verifier,
  }),
});
const tok = await r.json();
if (!tok.refresh_token) throw new Error(`トークンを受け取れませんでした: ${tok.error || r.status}`);

// 既存の値（LINE の鍵など）は残して Google の分だけ足す
const cf = new CloudFormationClient({ region: REGION });
const out = (await cf.send(new DescribeStacksCommand({ StackName: 'dr-baito-bot' }))).Stacks[0].Outputs;
const arn = out.find((o) => o.OutputKey === 'SecretArn').OutputValue;
const sm = new SecretsManagerClient({ region: REGION });
const cur = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: arn }))).SecretString || '{}');
await sm.send(new PutSecretValueCommand({
  SecretId: arn,
  SecretString: JSON.stringify({
    ...cur, GOOGLE_CLIENT_ID: client.client_id, GOOGLE_CLIENT_SECRET: client.client_secret, GOOGLE_REFRESH_TOKEN: tok.refresh_token,
  }),
}));
console.log(`✔ 保存しました（許可された範囲: ${tok.scope.split(' ').map((s) => s.split('/').pop()).join(', ')}）`);
