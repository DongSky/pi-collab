import test from "node:test";
import { verifySharedDatabase } from "./supervised-database";
test("short suite releases its database handle", () => verifySharedDatabase(100));
