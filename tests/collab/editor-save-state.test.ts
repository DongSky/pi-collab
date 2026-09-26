import test from "node:test";
import assert from "node:assert/strict";
import {acknowledgedEditorState,editorSaveLabel,type EditorSaveState} from "../../lib/collab/editor-save-state";
const pending:EditorSaveState={phase:"saving",dirty:true,revision:"4",savedAt:100,backup:"saved"};
test("an acknowledgement for an older edit cannot clear newer unsaved edits",()=>{
 const first=acknowledgedEditorState(pending,3,2,"5",undefined,200,false,true);
 assert.equal(first.dirty,true);assert.equal(editorSaveLabel(first),"未保存");assert.equal(first.savedAt,200);
 const final=acknowledgedEditorState(first,3,3,"6",undefined,300,false,true);
 assert.equal(final.dirty,false);assert.equal(editorSaveLabel(final),"已保存");assert.equal(final.revision,"6");
});
test("idle polling does not claim a new save or hide edits made during that request",()=>{
 const result=acknowledgedEditorState(pending,3,2,"4",undefined,200);
 assert.equal(result.savedAt,100);assert.equal(result.dirty,true);
 const confirm=acknowledgedEditorState({...pending,dirty:false},2,2,"4",undefined,300,true);
 assert.equal(confirm.savedAt,300);assert.equal(confirm.phase,"saved");
});
test("disconnection and revoked write access retain unsaved warnings",()=>{
 assert.equal(editorSaveLabel({...pending,phase:"offline"}),"离线 · 未保存");
 assert.equal(editorSaveLabel({...pending,phase:"error"}),"保存失败 · 未保存");
 const frozen=acknowledgedEditorState(pending,3,2,"4","草稿已冻结",200);
 assert.equal(frozen.dirty,true);assert.equal(editorSaveLabel(frozen),"只读 · 有未保存修改");
 const clean=acknowledgedEditorState(pending,2,2,"4","已交给 AI",200);
 assert.equal(editorSaveLabel(clean),"只读 · 已交给 AI");
});
