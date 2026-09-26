import test from "node:test";
import assert from "node:assert/strict";
import { mergeEditorText,editorBaseToken,validEditorBase } from "../../lib/collab/editor-merge";
test("Git three-way merging keeps independent edits, identical retries and newline endings",async()=>{
 const base="one\nunchanged\nthree\n",local="LOCAL\nunchanged\nthree\n",remote="one\nunchanged\nREMOTE\n";
 assert.deepEqual(await mergeEditorText(base,local,remote),{text:"LOCAL\nunchanged\nREMOTE\n",conflicted:false});
 assert.deepEqual(await mergeEditorText(base,local,local),{text:local,conflicted:false});
 assert.deepEqual(await mergeEditorText("abc","abc","def"),{text:"def",conflicted:false});
 const crlf=await mergeEditorText("a\r\nb\r\nc\r\n","A\r\nb\r\nc\r\n","a\r\nb\r\nC\r\n");assert.equal(crlf.text,"A\r\nb\r\nC\r\n");
});
test("overlapping replacement, delete/modify and same-position insertion require intervention",async()=>{
 for(const [base,local,remote] of [["same\n","mine\n","theirs\n"],["keep\nremove\n","keep\n","keep\nchanged\n"],["","mine\n","theirs\n"]]){
  const result=await mergeEditorText(base,local,remote);assert.equal(result.conflicted,true);assert.match(result.text,/<<<<<<< LOCAL/);assert.match(result.text,/\|\|\|\|\|\|\| BASE/);assert.match(result.text,/>>>>>>> SERVER/);
 }
});
test("save proofs bind document, version and base text",()=>{
 process.env.BETTER_AUTH_SECRET="test-only-editor-base-secret";
 const token=editorBaseToken("doc","1","original");assert.equal(validEditorBase("doc","1","original",token),true);
 for(const [id,revision,text] of [["other","1","original"],["doc","2","original"],["doc","1","forged"]])assert.equal(validEditorBase(id,revision,text,token),false);
});
