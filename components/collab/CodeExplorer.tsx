"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { downloadEditorText } from "./SharedCodeEditor";
import { WorkbenchIcon } from "./WorkbenchChrome";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { editorTools } from "./editor-tools";
import { syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";

type Node = { name: string; path: string; children: Map<string, Node>; file: boolean };
export function CodeFileTree({ files, selected, onOpen, disabled = false, deleted=[] }: { deleted?:string[]; files: string[]; selected: string; onOpen: (path: string) => void; disabled?: boolean }) {
 const [filter, setFilter] = useState("");
 const tree = useMemo(() => {
  const root: Node = { name: "", path: "", children: new Map(), file: false };
  for (const file of files.filter(f => f.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))) {
   let current = root; const parts = file.split("/");
   parts.forEach((name, i) => { let child = current.children.get(name); if (!child) { child = { name, path: parts.slice(0, i + 1).join("/"), children: new Map(), file: false }; current.children.set(name, child); } if (i === parts.length - 1) child.file = true; current = child; });
  }
  return root;
 }, [files, filter]);
 const render = (node: Node) => [...node.children.values()].sort((a,b) => Number(a.file)-Number(b.file) || a.name.localeCompare(b.name)).map(child => child.file ? <li key={child.path}><button className={deleted.includes(child.path)?"wb-deleted-file":undefined} title={child.path} disabled={disabled} aria-current={selected===child.path?"page":undefined} onClick={()=>onOpen(child.path)}><span aria-hidden="true"><WorkbenchIcon name="code"/></span>{child.name}{deleted.includes(child.path)?"（已删除）":""}</button></li> : <li key={child.path}><details open><summary title={child.path}>{child.name}</summary><ul>{render(child)}</ul></details></li>);
 return <aside className="wb-code-files" aria-label="代码文件树"><header>文件资源管理器 <small>{files.length}</small></header><input aria-label="搜索代码文件" placeholder="搜索文件…" value={filter} onChange={e=>setFilter(e.target.value)}/><nav aria-label="代码文件"><ul>{render(tree)}</ul>{!tree.children.size&&<p className="collab-muted">{filter?"没有匹配文件":"没有可显示文件"}</p>}</nav></aside>;
}
export function ReadonlyCode({ text, filename }: { text: string; filename: string }) {
 const host=useRef<HTMLDivElement>(null),view=useRef<EditorView|null>(null);
 const [search,setSearch]=useState(""),[notice,setNotice]=useState("");
 useEffect(()=>{const key=(event:KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="s"&&!event.isComposing){event.preventDefault();event.stopPropagation();setNotice("当前文件只读，无法保存到共享草稿。点击「下载副本」可保存到本机。");}};window.addEventListener("keydown",key,true);return()=>window.removeEventListener("keydown",key,true);},[]);
 useEffect(()=>{
  const editor=new EditorView({parent:host.current!,state:EditorState.create({doc:text,extensions:[lineNumbers(),highlightActiveLine(),keymap.of(defaultKeymap),EditorState.readOnly.of(true),EditorView.editable.of(false),syntaxHighlighting(classHighlighter),...editorTools(filename,true),EditorView.contentAttributes.of({"aria-label":`代码内容：${filename}`})]})});
  view.current=editor;return()=>{editor.destroy();view.current=null;};
 },[text,filename]);
 const find=()=>{const editor=view.current;if(!editor||!search)return;const current=editor.state.selection.main.to,index=text.indexOf(search,current),found=index<0?text.indexOf(search):index;if(found>=0){editor.dispatch({selection:{anchor:found,head:found+search.length},effects:EditorView.scrollIntoView(found,{y:"center"})});}};
 return <div className="wb-code-reader"><div className="wb-code-find"><input aria-label="在文件中查找" placeholder="在文件中查找…" value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();find();}}}/><button className="collab-button" onClick={find} disabled={!search}>下一个</button><span>只读 · {text.split("\n").length} 行</span><button className="collab-button" onClick={()=>{downloadEditorText(filename.split("/").at(-1)||"code.txt",text);setNotice("已发起下载副本，请在浏览器下载列表确认。");}}>下载副本</button></div>{notice&&<p role="status" className="wb-editor-notice">{notice}</p>}<div ref={host}/></div>;
}
