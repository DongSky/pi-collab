import { createHmac } from 'node:crypto';
export function demoTotp(secret) {
  const bits = [...secret].map(c => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest(), offset = digest[19] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
export async function demoSignIn(page, base, account) {
  await page.goto(base + '/sign-in');
  await page.getByLabel('邮箱', { exact: true }).fill(account.email);
  await page.getByLabel('密码', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  if (account.totpSecret) {
    const challenge = await Promise.race([
      page.waitForURL(base + '/', { timeout: 30000 }).then(() => false),
      page.getByLabel('验证码', { exact: true }).waitFor({ timeout: 30000 }).then(() => true),
    ]);
    if (challenge) {
      await page.getByLabel('验证码', { exact: true }).fill(demoTotp(account.totpSecret));
      await page.getByRole('button', { name: '验证并继续', exact: true }).click();
    }
  }
  await page.waitForURL(base + '/', { timeout: 30000 });
}
