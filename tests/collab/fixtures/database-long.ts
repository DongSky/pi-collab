import test from "node:test";
import { verifySharedDatabase } from "./supervised-database";
test("long suite survives the short suite exiting", () => verifySharedDatabase(1500));
