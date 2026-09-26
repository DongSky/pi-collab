import type {CompatibilityReport} from "@/lib/collab/contract-compatibility";
export function ContractCompatibility({report,claimed}:{report:CompatibilityReport;claimed:string}){
 const label={initial:"首次版本，无比较基线",attention:"发现兼容风险",incomplete:"存在未覆盖语义",'no-detected-risk':"已覆盖规则未发现收窄"}[report.status];
 return <section aria-label="接口兼容检查" className="collab-snapshot-card"><strong>{label}</strong>
 {report.status==="attention"&&claimed==="compatible"&&<p role="status">人工标注为兼容，但自动检查发现风险；请受影响任务负责人核对后再确认。</p>}
 <p className="collab-muted collab-small">比较提案与它引用的固定父版本。JSON Schema 检查可接受值是否收窄；不代表响应类型或实现代码兼容，也不代替测试、负责人确认或 Git 评审。</p>
 {report.findings.length>0&&<ul>{report.findings.map((f,i)=><li key={i}><strong>{f.severity==="risk"?"风险":"待核对"}</strong> · {f.message}<code className="collab-prewrap">{f.path}</code></li>)}</ul>}
 {report.truncated&&<p>发现项超过显示上限，请按完整定义继续核对。</p>}
 <details><summary>检查依据</summary><p className="collab-small collab-prewrap">规则版本：{report.engine}<br/>父定义：{report.parentHash??"无"}<br/>提案定义：{report.candidateHash}</p></details>
 </section>;
}
