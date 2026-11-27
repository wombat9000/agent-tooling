#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { EXIT_ERROR, EXIT_FINDINGS, EXIT_OK, type Subcommand } from './cli/args.mts';
import { exitCodeForResult, type ExitCodeOptions } from './cli/exit-code.mts';
import { runCli } from './cli/run.mts';

export { EXIT_ERROR, EXIT_FINDINGS, EXIT_OK, exitCodeForResult, type ExitCodeOptions, type Subcommand };

function isDirectCliRun(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectCliRun()) {
  runCli(process.argv.slice(2), process.cwd())
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const key = process.env.OPENROUTER_API_KEY?.trim();
      const message = error instanceof Error ? error.message : 'Judging failed';
      console.error(key ? message.replaceAll(key, '[redacted]') : message);
      process.exitCode = EXIT_ERROR;
    });
}
