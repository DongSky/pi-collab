import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
export async function writeEnvironmentFixture(root:string){
 await mkdir(path.join(root,"vendor/helper"),{recursive:true});
 await writeFile(path.join(root,"vendor/helper/package.json"),JSON.stringify({name:"collab-fixture-helper",version:"1.0.0",main:"index.cjs"}));await writeFile(path.join(root,"vendor/helper/index.cjs"),"module.exports=42;\n");
 await writeFile(path.join(root,"package.json"),JSON.stringify({name:"collab-environment-fixture",version:"1.0.0",dependencies:{"collab-fixture-helper":"file:vendor/helper"},scripts:{postinstall:"node -e \"require('fs').writeFileSync('must-not-install-script','bad')\""}}));
 await writeFile(path.join(root,"package-lock.json"),JSON.stringify({name:"collab-environment-fixture",version:"1.0.0",lockfileVersion:3,requires:true,packages:{"":{name:"collab-environment-fixture",version:"1.0.0",dependencies:{"collab-fixture-helper":"file:vendor/helper"}},"node_modules/collab-fixture-helper":{resolved:"vendor/helper",link:true},"vendor/helper":{name:"collab-fixture-helper",version:"1.0.0"}}}));
}
