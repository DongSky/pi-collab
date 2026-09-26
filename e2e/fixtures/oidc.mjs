import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';

// Disposable loopback IdP. No real credentials or external identity traffic.
export async function oidcFixture(){
 const pair=await generateKeyPair('RS256'),other=await generateKeyPair('RS256');
 const jwk={...await exportJWK(pair.publicKey),kid:'fixture',alg:'RS256',use:'sig'};
 const pending=new Map(),codes=new Map(),clients=new Map();let issuer,mode='valid';
 const server=createServer(async(req,res)=>{
  const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  try{
   const url=new URL(req.url,issuer);
   if(url.pathname==='/.well-known/openid-configuration')return json(200,{issuer,authorization_endpoint:`${issuer}/authorize`,token_endpoint:`${issuer}/token`,jwks_uri:`${issuer}/jwks`,response_types_supported:['code'],code_challenge_methods_supported:['S256'],id_token_signing_alg_values_supported:['RS256']});
   if(url.pathname==='/jwks')return json(200,{keys:[jwk]});
   if(url.pathname==='/authorize'){
    const q=Object.fromEntries(url.searchParams),client=clients.get(q.client_id);
    if(!client||q.redirect_uri!==client.redirect||q.response_type!=='code'||q.code_challenge_method!=='S256'||!q.nonce||!q.state)return json(400,{error:'invalid_request'});
    const ticket=randomUUID();pending.set(ticket,{...q,mode});
    res.writeHead(200,{'Content-Type':'text/html'});return res.end(`<html><body><h1>Local test identity</h1><form action="/approve" method="post"><input type="hidden" name="ticket" value="${ticket}"><label>Fixture email<input name="email" type="email" required></label><button>Continue</button></form></body></html>`);
   }
   let body='';for await(const chunk of req)body+=chunk;const values=new URLSearchParams(body);
   if(url.pathname==='/approve'){
    const ticket=values.get('ticket'),q=pending.get(ticket);pending.delete(ticket);if(!q)return json(400,{error:'invalid_request'});
    const code=randomUUID();codes.set(code,{...q,email:values.get('email')});const redirect=new URL(q.redirect_uri);redirect.searchParams.set('code',code);redirect.searchParams.set('state',q.mode==='state'?'wrong':q.state);res.writeHead(302,{Location:redirect.toString()});return res.end();
   }
   if(url.pathname==='/token'){
    const q=codes.get(values.get('code'));codes.delete(values.get('code'));
    const basic=req.headers.authorization?.startsWith('Basic ')?Buffer.from(req.headers.authorization.slice(6),'base64').toString().split(':'):null;
    const id=basic?.[0]??values.get('client_id'),secret=basic?.[1]??values.get('client_secret'),client=clients.get(id);
    if(!q||!client||client.secret!==secret||id!==q.client_id||values.get('redirect_uri')!==q.redirect_uri||q.mode==='pkce'||createHash('sha256').update(values.get('code_verifier')??'').digest('base64url')!==q.code_challenge)return json(400,{error:'invalid_grant'});
    const token=await new SignJWT({email:q.email,email_verified:q.mode!=='unverified',name:'Fixture user',nonce:q.mode==='nonce'?'wrong':q.nonce}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer(q.mode==='issuer'?`${issuer}/wrong`:issuer).setAudience(q.mode==='audience'?'wrong':id).setSubject(q.email).setIssuedAt().setExpirationTime('5m').sign(q.mode==='signature'?other.privateKey:pair.privateKey);
    return json(200,{access_token:'fixture-access',refresh_token:'fixture-refresh',id_token:token,token_type:'Bearer',expires_in:300});
   }
   json(404,{error:'not_found'});
  }catch{json(500,{error:'fixture_failure'});}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));issuer=`http://127.0.0.1:${server.address().port}`;
 return{issuer,register:(id,secret,redirect)=>clients.set(id,{secret,redirect}),setMode:value=>{mode=value;},close:()=>new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();})};
}
