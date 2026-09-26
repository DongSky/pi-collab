import {previewHandler,sweepPreviews} from "../lib/collab/preview-server";
import path from "node:path";
import { masterKey } from "../lib/collab/gateway/credentials";
import { GatewayStore } from "../lib/collab/gateway/store";
import { createModelGateway } from "../lib/collab/gateway/server";
import { dataRoot, gatewayConnectionString, localConfig } from "./local-config";

if (process.env.NODE_ENV === "production" && (!process.env.PI_COLLAB_GATEWAY_DATABASE_URL || !process.env.PI_COLLAB_MODEL_MASTER_KEY_FILE)) throw new Error("Configure gateway database role and external master key file");
const config = process.env.PI_COLLAB_GATEWAY_DATABASE_URL ? undefined : await localConfig();
const store = new GatewayStore(process.env.PI_COLLAB_GATEWAY_DATABASE_URL ?? gatewayConnectionString(config!));
const keyFile = process.env.PI_COLLAB_MODEL_MASTER_KEY_FILE ?? path.join(dataRoot, "model-master.key");
const port = Number(process.env.PI_COLLAB_GATEWAY_PORT ?? config?.gatewayPort ?? 30143);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid gateway port");
// A fresh install can start before a model is configured. Only explicit model
// registration creates a key; a lost key is never silently replaced on restart.
const previewRoot=process.env.PI_COLLAB_DATA_DIR??dataRoot;
const webOrigin=process.env.PI_COLLAB_WEB_ORIGIN??`http://127.0.0.1:${config?.port??30142}`;
const gateway = createModelGateway(store, () => masterKey(keyFile),{preview:previewHandler(store.pool,previewRoot,webOrigin)});
let sweeping=false;const sweep=()=>{if(!sweeping){sweeping=true;void sweepPreviews(store.pool,previewRoot).catch(()=>console.error('Preview cleanup unavailable')).finally(()=>{sweeping=false;});}};
const sweepTimer=setInterval(sweep,60000);sweep();
gateway.server.listen(port, "127.0.0.1", () => console.log(`pi-collab model gateway: 127.0.0.1:${port}`));
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; clearInterval(sweepTimer); await gateway.close(); await store.close(); };
process.on("SIGINT", () => void stop()); process.on("SIGTERM", () => void stop());
