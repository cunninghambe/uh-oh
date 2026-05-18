#!/usr/bin/env node
import fs from 'node:fs/promises';
import { Command } from 'commander';
import { readConfig, writeConfig } from './config.js';
import { login, makePrompt } from './commands/login.js';
import { upload } from './commands/upload.js';

const program = new Command();
program.name('uh-oh').description('CLI for uh-oh crash reporting').version('0.0.1');

program
  .command('login')
  .description('Log in to an uh-oh server and save the token')
  .requiredOption('--server <url>', 'Server URL (e.g. https://errors.example.com)')
  .action(async (opts: { server: string }) => {
    const code = await login(
      {
        prompt: makePrompt,
        config: { read: readConfig, write: writeConfig },
        log: (line) => process.stdout.write(line + '\n'),
      },
      { server: opts.server },
    );
    process.exit(code);
  });

const uploadCmd = program.command('upload').description('Upload symbol files');

uploadCmd
  .command('mapping')
  .description('Upload a ProGuard mapping.txt')
  .requiredOption('--project <slug>', 'Project slug')
  .requiredOption('--release <version+build>', 'Release string (e.g. 1.0.0+42)')
  .requiredOption('--file <path>', 'Path to mapping.txt')
  .action(async (opts: { project: string; release: string; file: string }) => {
    const code = await upload(
      {
        config: { read: readConfig },
        readFile: (p) => fs.readFile(p),
        log: (line) => process.stdout.write(line + '\n'),
      },
      'mapping',
      opts,
    );
    process.exit(code);
  });

uploadCmd
  .command('sourcemap')
  .description('Upload a Hermes source map (.map)')
  .requiredOption('--project <slug>', 'Project slug')
  .requiredOption('--release <version+build>', 'Release string (e.g. 1.0.0+42)')
  .requiredOption('--file <path>', 'Path to source map file')
  .action(async (opts: { project: string; release: string; file: string }) => {
    const code = await upload(
      {
        config: { read: readConfig },
        readFile: (p) => fs.readFile(p),
        log: (line) => process.stdout.write(line + '\n'),
      },
      'sourcemap',
      opts,
    );
    process.exit(code);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(2);
});
