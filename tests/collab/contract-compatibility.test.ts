import test from "node:test";
import assert from "node:assert/strict";
import {compareContracts} from "../../lib/collab/contract-compatibility";
import type {ContractContent} from "../../lib/collab/contract-schema";
const content=(definition:unknown,format:ContractContent['format']='json-schema'):ContractContent=>({title:'Orders',format,definition:JSON.stringify(definition),compatibility:'compatible',migrationGuide:'',mockJson:null});
const check=(a:unknown,b:unknown)=>compareContracts(JSON.stringify(content(a)),content(b));
test('detects renamed/removed fields, new requirements, type/enum changes and narrowed bounds with exact paths',()=>{
 const a={type:'object',properties:{id:{type:'number'},state:{enum:['new','done']},name:{type:'string',maxLength:100}},required:['id'],additionalProperties:false};
 const b={...a,properties:{orderId:{type:'integer'},state:{enum:['new']},name:{type:'string',maxLength:10}},required:['orderId']};const r=check(a,b);
 assert.equal(r.status,'attention');for(const path of ['/definition/properties/id','/definition/required/orderId','/definition/properties/state/enum','/definition/properties/name/maxLength'])assert.ok(r.findings.some(f=>f.path===path),path);
 assert.ok(check({type:'number'},{type:'integer'}).findings.some(f=>f.path==='/definition/type'));
 assert.ok(check(true,false).findings.some(f=>f.severity==='risk'));
});
test('safe widening has no detected narrowing; unsupported syntax never yields a compatibility claim',()=>{
 assert.equal(check({type:'integer',minimum:10},{type:'number',minimum:0}).status,'no-detected-risk');
 assert.equal(check({type:'object',additionalProperties:false},{type:'object'}).status,'no-detected-risk');
 assert.equal(check({$ref:'#/$defs/Order'},{ $ref:'#/$defs/Order'}).status,'incomplete');
 assert.equal(check({allOf:[{type:'string'}]},{allOf:[{type:'string'}]}).status,'incomplete');
 assert.equal(check({type:'string'},{type:'string',pattern:'^[A-Z]+$'}).status,'incomplete');
 assert.equal(compareContracts(null,content({})).status,'initial');
 assert.equal(check({},{properties:[],enum:'invalid',minLength:-1}).status,'incomplete');
});
test('recursive array checks and immutable hashes distinguish changed content and identify engine; excessive detail stays bounded',()=>{
 const a=content({type:'array',items:{type:'object',properties:{'a/b':{type:'string'}}}}),b=content({type:'array',items:{type:'object',properties:{'a/b':{type:'number'}}}});
 const r=compareContracts(JSON.stringify(a),b);assert.equal(r.engine,'contract-structure-v1');assert.ok(r.findings.some(f=>f.path==='/definition/items/properties/a~1b/type'));assert.notEqual(r.parentHash,r.candidateHash);assert.deepEqual(r,compareContracts(JSON.stringify(a),b));
 const many=Object.fromEntries(Array.from({length:150},(_,i)=>[`x${i}`,{type:'string'}]));const limited=check({},{properties:many});assert.equal(limited.findings.length,100);assert.equal(limited.truncated,true);
});
test('OpenAPI removal has operation evidence; response changes and references remain explicit unknowns',()=>{
 const a={openapi:'3.1.0',paths:{'/orders':{get:{responses:{200:{description:'OK'}}},post:{responses:{201:{description:'Created'}}}}}};
 const b={openapi:'3.1.0',paths:{'/orders':{get:{responses:{200:{description:'Changed'}}}}}};
 const r=compareContracts(JSON.stringify(content(a,'openapi')),content(b,'openapi'));assert.equal(r.status,'attention');assert.ok(r.findings.some(f=>f.path==='/paths/~1orders/post'&&f.severity==='risk'));assert.ok(r.findings.some(f=>f.path==='/paths/~1orders/get'&&f.severity==='unknown'));
});
