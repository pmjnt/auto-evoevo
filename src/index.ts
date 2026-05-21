import { loadConfig } from "./config.js";
import { run } from "./runner.js";

type CliArgs = {
  configPath: string;
  forceDryRun: boolean;
};

function parseArgs(args: string[]): CliArgs {
  let configPath = "config.local.json";
  let forceDryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--dry-run") {
      forceDryRun = true;
      continue;
    }

    if (arg === "--config") {
      const nextArg = args[index + 1];

      if (nextArg === undefined) {
        throw new Error("--config requires a path");
      }

      configPath = nextArg;
      index += 1;
      continue;
    }

    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { configPath, forceDryRun };
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.configPath);
const effectiveConfig = {
  ...config,
  dryRun: args.forceDryRun || config.dryRun,
};

await run(effectiveConfig);
