import { existsSync } from "node:fs";
import path from "node:path";
import type { ValidationTool } from "./validation-config";

/** Detect the project's test command by looking for well-known files. */
export function detectTestCommand(projectDir: string): { tool: ValidationTool; args: string[] } | null {
  const has = (name: string) => existsSync(path.join(projectDir, name));

  // Node.js
  if (has("package.json")) return { tool: "npm", args: ["test"] };
  // Python
  if (has("pytest.ini") || has("pyproject.toml") || has("setup.py") || has("requirements.txt")) return { tool: "pytest", args: [] };
  // Go
  if (has("go.mod")) return { tool: "go", args: ["test", "./..."] };
  // Rust
  if (has("Cargo.toml")) return { tool: "cargo", args: ["test"] };
  // Java (Maven)
  if (has("pom.xml")) return { tool: "mvn", args: ["test"] };
  // Java (Gradle)
  if (has("build.gradle") || has("build.gradle.kts")) return { tool: "gradle", args: ["test"] };
  // Ruby
  if (has("Gemfile")) return { tool: "bundle", args: ["exec", "rake", "test"] };
  // PHP
  if (has("composer.json")) return { tool: "composer", args: ["test"] };

  return null;
}

/** Human-readable description of what will run. */
export function describeTestCommand(cmd: { tool: string; args: string[] }): string {
  return [cmd.tool, ...cmd.args].join(" ");
}
