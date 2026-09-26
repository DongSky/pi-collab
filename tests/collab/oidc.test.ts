import test,{before,after} from "node:test";
import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {Pool} from "pg";
import {localConfig,applicationEnvironment,connectionString} from "../../scripts/local-config";
import {startNativeDatabase} from "../../scripts/native-database";
import {migrate} from "../../scripts/migrate";
import {provisioningAuth} from "../../lib/collab/auth";
import {asUser,database} from "../../lib/collab/database";
import {organizationOidc,oidcBindings,revokeOidcBinding,oidcRuntime,oidcProviders} from "../../lib/collab/oidc";
const config=await localConfig(),name=`pi_collab_test_${randomBytes(6).toString('hex')}`,native=await startNativeDatabase(config);
Object.assign(process.env,applicationEnvironment(config),{DATABASE_URL:connectionString(config,false,name)});
const admin=new Pool({connectionString:connectionString(config,true,name)}),org=randomUUID(),users:string[]=[];
const configure=(id:string,body:unknown,actor=users[0])=>asUser(actor,db=>db.query("SELECT collab.configure_oidc($1,$2,$3)",[org,id,body]));
const binding=(provider:string,user=users[1])=>admin.query('INSERT INTO public.account(id,"accountId","providerId","userId","createdAt","updatedAt") VALUES($1,$2,$3,$4,now(),now())',[randomUUID(),user,`oidc-${provider}`,user]);
const session=(provider:string,revision=1,hash:string|null=null)=>admin.query('INSERT INTO public.session(id,token,"userId","expiresAt","createdAt","updatedAt","oidcProviderId","oidcProviderVersion","oidcChallengeHash") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now(),$4,$5,$6)',[randomUUID(),randomUUID(),users[1],provider,String(revision),hash]);
async function provider(){const id=randomUUID();await configure(id,{action:'create',name:'Local OIDC',issuer:'https://identity.example.test',clientId:id,secret:{ciphertext:'not-plaintext'},metadata:{issuer:'https://identity.example.test'},reason:'Configure identity acceptance'});return id;}
before(async()=>{await migrate(config,name);const auth=provisioningAuth(admin);for(let i=0;i<3;i++)users.push((await auth.api.signUpEmail({body:{name:`OIDC ${i}`,email:`oidc${i}@test.invalid`,password:randomBytes(20).toString('hex')}})).user.id);await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'OIDC team',$2)",[org,users[0]]);for(let i=0;i<2;i++)await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)",[org,users[i],i===0?'owner':'member']);await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1',[users[0]]);});
after(async()=>{await database().end();globalThis.__piCollabPool=undefined;await admin.end();const cleanup=new Pool({connectionString:connectionString(config,true,'postgres')});await cleanup.query(`DROP DATABASE "${name}" WITH (FORCE)`);await cleanup.end();await native.stop();});
test('provider management requires MFA administrator; public catalogue omits sealed secret',async()=>{
 const id=await provider();await assert.rejects(organizationOidc(users[1],org),/forbidden/);await assert.rejects(configure(id,{action:'toggle',expectedVersion:1,enabled:false,reason:'Unauthorized change attempt'},users[1]),/forbidden/);
 assert.equal(JSON.stringify(await oidcProviders()).includes('ciphertext'),false);assert.equal((await oidcRuntime(id))!.version,1);
 await assert.rejects(binding(id,users[2]),/oidc_unavailable/);await binding(id);assert.equal((await oidcBindings(users[1])).find(p=>p.id===id)?.bound,true);
 await session(id);await configure(id,{action:'rotate',expectedVersion:1,secret:{ciphertext:'rotated'},reason:'Rotate fixture client secret'});
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.session WHERE "userId"=$1',[users[1]])).rows[0].n,0);await assert.rejects(session(id,1),/oidc_unavailable/);await session(id,2);
 await assert.rejects(configure(id,{action:'toggle',expectedVersion:1,enabled:false,reason:'Stale update of provider'}),/stale_revision/);
});
test('single-use MFA proof and revocation gate session creation; unlink preserves credential account',async()=>{
 const id=await provider();await binding(id);const hash=randomBytes(32).toString('hex');await database().query('SELECT collab.record_oidc_pending($1,$2,$3,1)',[hash,users[1],id]);await session(id,1,hash);await assert.rejects(session(id,1,hash),/oidc_unavailable/);
 await configure(id,{action:'toggle',expectedVersion:1,enabled:false,reason:'Disable identity provider now'});assert.equal(await oidcRuntime(id),null);await assert.rejects(session(id,1),/oidc_unavailable/);
 await revokeOidcBinding(users[1],id);assert.equal((await oidcBindings(users[1])).find(p=>p.id===id)?.bound,false);assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.account WHERE "userId"=$1 AND "providerId"=\'credential\'',[users[1]])).rows[0].n,1);
});
