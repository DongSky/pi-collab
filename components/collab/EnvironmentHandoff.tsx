"use client";
import {useState} from "react";
import {collabApi} from "./api";
type Data={run:{model_name:string|null};environment:{status:string;recipe:{version?:number;install:string};evidence:{runtime:Record<string,string|null>;dependencies:{path:string;hash:string}[];omissions?:string[];error?:string}|null}|null};
export function EnvironmentHandoff({runId,onRestore}:{runId:string;onRestore?:()=>void}){
 const [data,setData]=useState<Data|null>(null),[error,setError]=useState("");
 return <details onToggle={event=>{if(event.currentTarget.open&&!data)void collabApi<Data>(`runs/${runId}/environment`).then(setData).catch(e=>setError(e.message));}}><summary>环境交接与重建</summary>{error&&<p role="alert">{error}</p>}{data&&<>{data.environment?<><p>原运行模型：{data.run.model_name??"诊断运行"} · 配方版本 {data.environment.recipe.version??0} · {data.environment.recipe.install} · {data.environment.status}</p>{data.environment.evidence&&<><p>Node {data.environment.evidence.runtime.node} · {data.environment.evidence.runtime.platform}/{data.environment.evidence.runtime.arch} · {data.environment.evidence.runtime.backend}</p><p>接续前会检查 Node、npm、Pi、平台和架构指纹；运行时不一致时停止，不静默换环境。测试库和端口重新分配。</p><h4>依赖清单</h4>{data.environment.evidence.dependencies.map(d=><p className="collab-small collab-git-identity" key={d.path}>{d.path} · {d.hash}</p>)}{data.environment.evidence.error&&<p role="alert">原环境准备未完成：{data.environment.evidence.error}</p>}<details><summary>完整运行时指纹</summary><pre className="collab-prewrap">{JSON.stringify(data.environment.evidence.runtime,null,2)}</pre></details></>}</>:<p>旧运行没有完整环境记录；只能恢复代码，需重新核对工具链。</p>}
 <p>恢复会新建工作区并重新执行固定的依赖安装配方。外部服务状态、测试数据、秘密、运行中进程和安装脚本未捕获，需要重新配置和验证。</p>{onRestore&&<button className="collab-button" onClick={onRestore}>选择此交接环境，准备新运行</button>}</>}</details>;
}
