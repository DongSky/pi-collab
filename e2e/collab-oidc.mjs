import assert from 'node:assert/strict';
import {oidcFixture} from './fixtures/oidc.mjs';
export async function verifyOidc({base,owner,member,memberContext,browser,secret,totp,signIn}){
 const idp=await oidcFixture(),clean=await browser.newContext(),visitor=await clean.newPage();
 const approve=async(page,email)=>{await page.getByLabel('Fixture email').fill(email);await page.getByRole('button',{name:'Continue',exact:true}).click();};
 const login=async(page,email)=>{
  await page.goto(`${base}/sign-in`);
  for(let attempt=0;attempt<2;attempt++){
   const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/auth/sign-in/social')),page.getByRole('button',{name:/使用 .*Test OIDC 登录/}).click()]);
   if(response.status()!==429){assert.equal(response.status(),200);break;}
   await new Promise(resolve=>setTimeout(resolve,Math.max(1,Number(response.headers()['retry-after']??11))*1000+100));
  }
  await approve(page,email);
 };
 try{
  await owner.goto(`${base}/`);await owner.getByRole('link',{name:'管理 Browser identity team'}).click();
  await owner.getByText('添加身份提供方',{exact:true}).click();await owner.getByLabel('提供方名称',{exact:true}).fill('Test OIDC');await owner.getByLabel('Issuer URL',{exact:true}).fill(idp.issuer);await owner.getByLabel('Client ID',{exact:true}).fill('fixture-client');await owner.getByLabel('Client Secret',{exact:true}).fill('fixture-secret');await owner.getByLabel('添加原因',{exact:true}).fill('Enable local identity acceptance');await owner.getByRole('button',{name:'验证发现文档并添加'}).click();
  const callback=await owner.getByLabel('Test OIDC 回调地址').inputValue();const id=callback.split('oidc-')[1];idp.register('fixture-client','fixture-secret',callback);
  const catalogue=await(await clean.request.get(`${base}/api/collab/oidc/providers`)).json();assert.equal(JSON.stringify(catalogue).includes('fixture-secret'),false);
  await login(visitor,'browser-member@pi-collab.test');await visitor.waitForURL(/sign-in\?.*error/i);assert.equal((await clean.request.get(`${base}/api/collab/me`)).status(),401);
  await member.goto(`${base}/account`);await member.getByRole('button',{name:'绑定组织身份',exact:true}).click();await approve(member,'browser-member@pi-collab.test');await member.waitForURL(`${base}/account`);await member.getByRole('button',{name:'解除绑定并退出登录'}).waitFor();
  await memberContext.request.post(`${base}/api/collab/auth/sign-out`,{headers:{Origin:base},data:{}});
  await login(member,'browser-member@pi-collab.test');await member.waitForURL(`${base}/`);assert.equal((await(await memberContext.request.get(`${base}/api/collab/auth/get-session`)).json()).session.oidcProviderId,id);assert.equal((await memberContext.request.get(`${base}/api/collab/me`)).status(),200);
  for(const mode of ['signature','issuer','audience','nonce','unverified','state','pkce']){idp.setMode(mode);await login(visitor,'browser-member@pi-collab.test');await visitor.waitForURL(/sign-in\?.*error/i);assert.equal((await clean.request.get(`${base}/api/collab/me`)).status(),401,mode);}idp.setMode('valid');
  await owner.goto(`${base}/account`);await owner.getByRole('button',{name:'绑定组织身份',exact:true}).click();await approve(owner,'browser-owner@pi-collab.test');await owner.waitForURL(`${base}/account`);await owner.getByRole('button',{name:'解除绑定并退出登录'}).waitFor();
  await login(visitor,'browser-owner@pi-collab.test');await visitor.waitForURL(`${base}/sign-in?oidcMfa=1`);assert.equal((await clean.request.get(`${base}/api/collab/me`)).status(),401);
  // Removing the auxiliary marker cannot strip the provider binding from MFA.
  await clean.clearCookies({name:/oidc_mfa$/});
  await visitor.getByLabel('验证码',{exact:true}).fill(totp(secret));await visitor.getByRole('button',{name:'验证并继续'}).click();await visitor.waitForURL(`${base}/`);assert.equal((await(await clean.request.get(`${base}/api/collab/auth/get-session`)).json()).session.oidcProviderId,id);assert.equal((await clean.request.get(`${base}/api/collab/me`)).status(),200);
  await owner.goto(`${base}/`);await owner.getByRole('link',{name:'管理 Browser identity team'}).click();
  await owner.getByLabel('OIDC 变更原因',{exact:true}).fill('Revoke fixture provider for acceptance');await Promise.all([owner.waitForResponse(r=>r.url().endsWith('/oidc')&&r.request().method()==='POST'),owner.getByRole('button',{name:'停用提供方并撤销会话'}).click()]);
  assert.equal((await memberContext.request.get(`${base}/api/collab/me`)).status(),401);assert.equal((await clean.request.get(`${base}/api/collab/me`)).status(),401);
  await signIn(owner,'browser-owner@pi-collab.test',secret);await owner.getByRole('link',{name:'管理 Browser identity team'}).click();await owner.getByRole('heading',{name:'Test OIDC · 停用'}).waitFor();
  await owner.screenshot({path:'test-results/collab/oidc-desktop.png',fullPage:true});await owner.setViewportSize({width:390,height:844});assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await owner.screenshot({path:'test-results/collab/oidc-mobile.png',fullPage:true});
  await signIn(member,'browser-member@pi-collab.test');await member.goto(`${base}/account`);await member.getByRole('button',{name:'解除绑定并退出登录'}).click();await member.waitForURL(`${base}/sign-in`);assert.equal((await memberContext.request.get(`${base}/api/collab/me`)).status(),401);
  console.log('PASS: OIDC configuration, explicit binding, login, signed-token/state/PKCE rejection, local MFA, provider disable, password fallback and unlink.');
 }finally{await clean.close();await idp.close();}
}
