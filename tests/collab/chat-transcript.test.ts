import test from 'node:test';
import assert from 'node:assert/strict';
import {chatRows,type ChatEvent} from '../../lib/collab/chat-transcript';
const rows=(...events:ChatEvent[])=>chatRows([{payload:{events}}]);
test('streamed text is replaced by its canonical message once, tools retain interleaved identity',()=>{
 const result=rows({type:'assistant_text',text:'hel'},{type:'assistant_text',text:'lo'},{type:'message_end',message:{role:'assistant',content:[{text:'hello'}]}},{type:'tool_execution_start',toolCallId:'a',toolName:'read'},{type:'tool_execution_start',toolCallId:'b',toolName:'bash'},{type:'tool_execution_end',toolCallId:'b',content:[{text:'test failed'}],isError:true},{type:'tool_execution_end',toolCallId:'a',content:[{text:'file'}]},{type:'assistant_text',text:'done'});
 assert.equal(result.length,4);assert.equal(result[0].text,'hello');assert.equal(result[0].pending,false);assert.equal(result[1].text,'file');assert.equal(result[2].failed,true);assert.equal(result[3].pending,true);
});
test('truncated tool results remain visible, user system context and private reasoning are excluded',()=>{
 assert.deepEqual(rows({type:'message_end',message:{role:'user',content:[{text:'internal prompt'}]}},{type:'thinking_delta',text:'private'}),[]);
 const [result]=rows({type:'tool_execution_end',toolName:'bash',toolCallId:'missing',content:[{text:'result'}]});assert.equal(result.text,'result');assert.equal(result.pending,false);
});
import {withChatInstructions} from '../../lib/collab/chat-transcript';
test('follow-up messages stay between earlier output and subsequent replies',()=>{
 const output=rows({type:'message_end',message:{role:'assistant',content:[{text:'before'}]}},{type:'message_end',message:{role:'assistant',content:[{text:'after'}]}});
 assert.deepEqual(withChatInstructions(output,[{id:'instruction',text:'change direction',after:output[0].id}]).map(r=>r.text),['before','change direction','after']);
});
