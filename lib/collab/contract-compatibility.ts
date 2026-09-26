import {createHash} from "node:crypto";
import type {ContractContent} from "./contract-schema";
export type CompatibilityFinding={severity:"risk"|"unknown";path:string;message:string};
export type CompatibilityReport={engine:"contract-structure-v1";status:"initial"|"attention"|"incomplete"|"no-detected-risk";parentHash:string|null;candidateHash:string;findings:CompatibilityFinding[];truncated:boolean};
const hash=(v:string)=>createHash("sha256").update(v).digest("hex");
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,value)=>value&&typeof value==="object"&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
const equal=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const names=(v:unknown):string[]=>Array.isArray(v)?v.filter((x):x is string=>typeof x==="string"):[];
const pointer=(v:string)=>v.replaceAll("~","~0").replaceAll("/","~1");
/** Advisory comparison of immutable contract inputs, never an approval or a proof of compatibility. */
export function compareContracts(parentBody:string|null,candidate:ContractContent):CompatibilityReport{
 const report:CompatibilityReport={engine:"contract-structure-v1",status:"initial",parentHash:parentBody===null?null:hash(parentBody),candidateHash:hash(canonical(candidate)),findings:[],truncated:false};
 if(parentBody===null)return report;
 const add=(severity:CompatibilityFinding["severity"],path:string,message:string)=>{if(report.findings.length<100)report.findings.push({severity,path,message});else report.truncated=true;};
 let parent:ContractContent;try{parent=JSON.parse(parentBody);}catch{add("unknown","/","父版本无法解析，不能比较。");return finish();}
 function finish(){report.status=report.findings.some(f=>f.severity==="risk")?"attention":report.findings.length||report.truncated?"incomplete":"no-detected-risk";return report;}
 if(parent.format!==candidate.format){add("unknown","/format","定义格式改变，需要重新核对消费者。");return finish();}
 if(candidate.format==="text"){add("unknown","/definition","文本约定暂不做语义推断，请按固定版本人工核对。");return finish();}
 let before:unknown,after:unknown;try{before=JSON.parse(parent.definition);after=JSON.parse(candidate.definition);}catch{add("unknown","/definition","结构化定义无法解析。");return finish();}
 const annotations=new Set(["title","description","default","examples","example","deprecated","$comment","$schema","$id","readOnly","writeOnly"]);
 const supported=new Set(["type","properties","required","items","additionalProperties","enum","const","minimum","maximum","exclusiveMinimum","exclusiveMaximum","minLength","maxLength","minItems","maxItems","minProperties","maxProperties"]);
 const supportedTypes=new Set(["null","boolean","object","array","number","integer","string"]);
 let visited=0;
 function schema(old:unknown,next:unknown,path:string,depth=0){
  if(++visited>1500||depth>24){add("unknown",path,"结构超过首版检查范围，需要人工核对。");return;}
  if(old===false||next===true)return;
  if(next===false){if(old!==false)add("risk",path,"新定义拒绝此处全部值。");return;}
  if(next===null||typeof next!=="object"||Array.isArray(next)||old!==true&&(old===null||typeof old!=="object"||Array.isArray(old))){add("unknown",path,"不是受支持的对象或布尔 Schema。");return;}
  const a=object(old),b=object(next);
  const numeric=(value:unknown,key:string):value is number=>typeof value==="number"&&Number.isFinite(value)&&(!/^(min|max)(Length|Items|Properties)$/.test(key)||Number.isInteger(value)&&value>=0);
  for(const s of [a,b]){
   if(s.properties!==undefined&&(s.properties===null||typeof s.properties!=="object"||Array.isArray(s.properties)))add("unknown",`${path}/properties`,"properties 声明不是对象。");
   if(s.enum!==undefined&&(!Array.isArray(s.enum)||s.enum.length===0))add("unknown",`${path}/enum`,"enum 声明不是非空数组。");
   if(s.additionalProperties!==undefined&&typeof s.additionalProperties!=="boolean"&&(s.additionalProperties===null||typeof s.additionalProperties!=="object"||Array.isArray(s.additionalProperties)))add("unknown",`${path}/additionalProperties`,"additionalProperties 声明无效。");
   for(const k of ["minimum","maximum","exclusiveMinimum","exclusiveMaximum","minLength","maxLength","minItems","maxItems","minProperties","maxProperties"])if(s[k]!==undefined&&!numeric(s[k],k))add("unknown",`${path}/${k}`,`${k} 不是受支持的数值约束。`);
   if(s.$schema!==undefined&&!["https://json-schema.org/draft/2020-12/schema","https://json-schema.org/draft/2019-09/schema","http://json-schema.org/draft-07/schema#","http://json-schema.org/draft-06/schema#"].includes(String(s.$schema)))add("unknown",`${path}/$schema`,"未覆盖此 Schema 方言。");
  }
  if(!equal(a.$schema,b.$schema))add("unknown",`${path}/$schema`,"Schema 方言声明变化，需要人工核对。");
  for(const key of new Set([...Object.keys(a),...Object.keys(b)]))if(!supported.has(key)&&!annotations.has(key))add("unknown",`${path}/${pointer(key)}`,`未解释 ${key} 的语义；存在此关键字时不能据此判定兼容。`);
  const types=(v:unknown)=>typeof v==="string"?[v]:names(v),previous=types(a.type),current=types(b.type);
  if([a.type,b.type].some(v=>v!==undefined&&!(typeof v==="string"||Array.isArray(v)&&v.length>0&&v.every(x=>typeof x==="string")))||[...previous,...current].some(t=>!supportedTypes.has(t)))add("unknown",`${path}/type`,"type 声明不在支持范围。");
  if(current.length&&(!previous.length||previous.some(t=>!current.includes(t)&&!(t==="integer"&&current.includes("number")))))add("risk",`${path}/type`,`可接受类型收窄或改变：${previous.join(" / ")||"未限定"} → ${current.join(" / ")}。`);
  const values=(s:Record<string,unknown>):unknown[]|undefined=>"const" in s?[s.const]:Array.isArray(s.enum)?s.enum:undefined;
  const av=values(a),bv=values(b);if(bv&&(!av||av.some(v=>!bv.some(n=>equal(v,n)))))add("risk",`${path}/enum`,"允许值被收窄或替换，既有值可能被拒绝。");
  for(const key of ["minimum","exclusiveMinimum","minLength","minItems","minProperties"]){if(numeric(b[key],key)&&(!numeric(a[key],key)||b[key]>a[key]))add("risk",`${path}/${key}`,`${key} 下限提高到 ${b[key]}。`);}
  for(const key of ["maximum","exclusiveMaximum","maxLength","maxItems","maxProperties"]){if(numeric(b[key],key)&&(!numeric(a[key],key)||b[key]<a[key]))add("risk",`${path}/${key}`,`${key} 上限降低到 ${b[key]}。`);}
  for(const key of ["exclusiveMinimum","exclusiveMaximum"])if(typeof a[key]==="boolean"||typeof b[key]==="boolean")add("unknown",`${path}/${key}`,"旧版布尔边界语法需要人工核对。");
  if([a.required,b.required].some(v=>v!==undefined&&(!Array.isArray(v)||v.some(x=>typeof x!=="string"))))add("unknown",`${path}/required`,"required 声明不是字符串数组。");
  for(const key of names(b.required))if(!names(a.required).includes(key))add("risk",`${path}/required/${pointer(key)}`,`新增必填字段 ${key}。`);
  if(b.additionalProperties===false&&a.additionalProperties!==false)add("risk",`${path}/additionalProperties`,"新增禁止额外字段的约束。");
  if(typeof a.additionalProperties==="object"||typeof b.additionalProperties==="object")add("unknown",`${path}/additionalProperties`,"额外字段的 Schema 约束需人工核对。");
  const ap=object(a.properties),bp=object(b.properties);
  for(const key of Object.keys(ap))if(!Object.hasOwn(bp,key)&&b.additionalProperties===false)add("risk",`${path}/properties/${pointer(key)}`,`字段 ${key} 被移除且新定义禁止额外字段。`);
  for(const key of Object.keys(bp))schema(Object.hasOwn(ap,key)?ap[key]:a.additionalProperties??true,bp[key],`${path}/properties/${pointer(key)}`,depth+1);
  if(b.items!==undefined)schema(a.items??true,b.items,`${path}/items`,depth+1);
 }
 if(candidate.format==="json-schema")schema(before,after,"/definition");
 else {
  const a=object(before),b=object(after),ap=object(a.paths),bp=object(b.paths);
  if(typeof a.openapi!=="string"||typeof b.openapi!=="string"||!a.openapi.startsWith("3.")||!b.openapi.startsWith("3.")){add("unknown","/openapi","仅检查 OpenAPI 3 的固定 JSON 定义。");return finish();}
  // Operation removal has a clear consumer impact. Other changes are surfaced
  // without claiming full request/response variance or reference resolution.
  for(const [path,item] of Object.entries(ap))for(const method of ["get","post","put","patch","delete","head","options","trace"]){
   const old=object(item)[method];if(old===undefined)continue;
   const next=object(bp[path])[method],where=`/paths/${pointer(path)}/${method}`;
   if(next===undefined)add("risk",where,`移除接口 ${method.toUpperCase()} ${path}。`);
   else if(!equal(old,next))add("unknown",where,`接口 ${method.toUpperCase()} ${path} 的参数、返回或说明发生变化，需要消费者核对。`);
  }
  for(const key of new Set([...Object.keys(a),...Object.keys(b)]))if(key!=="paths"&&!equal(a[key],b[key]))add("unknown",`/${pointer(key)}`,`OpenAPI ${key} 发生变化，首版不解析其完整兼容语义。`);
  add("unknown","/paths","OpenAPI 首版只识别接口删除与变化；引用、认证及请求/响应类型兼容仍需人工核对。");
 }
 return finish();
}
