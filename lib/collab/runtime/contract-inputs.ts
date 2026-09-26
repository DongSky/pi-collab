import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { contractContent, contractPins, type ContractPin } from "../contract-schema";
class ContractInputError extends Error { constructor(readonly code: string) { super(code); } }

function parsed(raw: ContractPin[]) {
  const pins = contractPins.parse(raw);
  for (const pin of pins) {
    if (createHash("sha256").update(pin.body).digest("hex") !== pin.bodyHash) throw new ContractInputError("snapshot_contract_input_invalid");
    contractContent.parse(JSON.parse(pin.body));
  }
  return pins;
}
export async function materializeContractInputs(workspaceRoot: string, raw: ContractPin[]) {
  const pins = parsed(raw);
  if (!pins.length) return;
  await writeFile(path.join(workspaceRoot, "contracts.json"), JSON.stringify(pins), { flag: "wx", mode: 0o444 });
}
export async function verifyContractInputs(workspaceRoot: string, raw: ContractPin[]) {
  const pins = parsed(raw), file = path.join(workspaceRoot, "contracts.json");
  try {
    const stat = await lstat(file); if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new ContractInputError("snapshot_contract_input_invalid");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = await handle.readFile(); if (bytes.length > 4 * 1024 * 1024 || JSON.stringify(contractPins.parse(JSON.parse(bytes.toString("utf8")))) !== JSON.stringify(pins)) throw new ContractInputError("snapshot_contract_input_changed");
    } finally { await handle.close(); }
  } catch (error) {
    if (!pins.length && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
