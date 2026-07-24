#!/usr/bin/env node
import fs from 'node:fs/promises';
import { Command, Option } from 'commander';
import { readConfig, writeConfig } from './config.js';
import { login, makePrompt } from './commands/login.js';
import { upload } from './commands/upload.js';
import { uploadNextSourcemaps } from './commands/next-sourcemaps.js';
import { projectList, projectCreate, projectDsn } from './commands/project.js';
import { listFilesRecursive } from './fsWalk.js';
import { resolveCommitSha } from './commitSha.js';

// Bound to the real log/process.env/process.cwd()/git spawn - the one
// resolveCommitSha implementation every command wires into its deps.
const resolveCommit = (flagValue: string | undefined): Promise<string | undefined> =>
  resolveCommitSha(flagValue, { log: (line) => process.stdout.write(line + '\n') });

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

const projectCmd = program.command('project').description('Manage projects');

projectCmd
  .command('list')
  .description('List projects (name, slug, publicKey, created)')
  .action(async () => {
    const code = await projectList({
      config: { read: readConfig },
      log: (line) => process.stdout.write(line + '\n'),
    });
    process.exit(code);
  });

projectCmd
  .command('create')
  .description('Create a new project and print its slug + DSN')
  .argument('<name>', 'Project name')
  .action(async (name: string) => {
    const code = await projectCreate(
      {
        config: { read: readConfig },
        log: (line) => process.stdout.write(line + '\n'),
      },
      { name },
    );
    process.exit(code);
  });

projectCmd
  .command('dsn')
  .description('Print a project DSN and the consumer env lines')
  .argument('<slug>', 'Project slug')
  .action(async (slug: string) => {
    const code = await projectDsn(
      {
        config: { read: readConfig },
        log: (line) => process.stdout.write(line + '\n'),
      },
      { slug },
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
        statFile: (p) => fs.stat(p),
        log: (line) => process.stdout.write(line + '\n'),
        resolveCommitSha: resolveCommit,
      },
      'mapping',
      opts,
    );
    process.exit(code);
  });

uploadCmd
  .command('sourcemap')
  .description('Upload a source map (.map) — defaults to the hermes/android flow')
  .requiredOption('--project <slug>', 'Project slug')
  .requiredOption('--release <version+build>', 'Release string (e.g. 1.0.0+42)')
  .requiredOption('--file <path>', 'Path to source map file')
  .addOption(
    new Option(
      '--platform <platform>',
      'Escape hatch: upload as a web/node map instead of the default hermes/android flow',
    ).choices(['web', 'node']),
  )
  .option(
    '--bundle-path <path>',
    'Bundle path relative to the app build (forward slashes, e.g. static/chunks/123.js)',
  )
  .option(
    '--commit <sha>',
    'Commit SHA to record on the release (falls back to UH_OH_COMMIT_SHA, then `git rev-parse HEAD`)',
  )
  .action(
    async (opts: {
      project: string;
      release: string;
      file: string;
      platform?: 'web' | 'node';
      bundlePath?: string;
      commit?: string;
    }) => {
      const code = await upload(
        {
          config: { read: readConfig },
          readFile: (p) => fs.readFile(p),
          statFile: (p) => fs.stat(p),
          log: (line) => process.stdout.write(line + '\n'),
          resolveCommitSha: resolveCommit,
        },
        'sourcemap',
        opts,
      );
      process.exit(code);
    },
  );

uploadCmd
  .command('next-sourcemaps')
  .description('Upload every browser + server source map from a Next.js .next build')
  .requiredOption('--project <slug>', 'Project slug')
  .requiredOption('--release <version+build>', 'Release string (e.g. 1.0.0+42)')
  .requiredOption('--dir <path>', 'Path to the .next build directory')
  .option('--dry-run', 'Print what would be uploaded without making any network calls')
  .option(
    '--commit <sha>',
    'Commit SHA to record on the release (falls back to UH_OH_COMMIT_SHA, then `git rev-parse HEAD`)',
  )
  .action(
    async (opts: {
      project: string;
      release: string;
      dir: string;
      dryRun?: boolean;
      commit?: string;
    }) => {
      const code = await uploadNextSourcemaps(
        {
          config: { read: readConfig },
          readFile: (p) => fs.readFile(p),
          statFile: (p) => fs.stat(p),
          listFiles: listFilesRecursive,
          log: (line) => process.stdout.write(line + '\n'),
          resolveCommitSha: resolveCommit,
        },
        opts,
      );
      process.exit(code);
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(2);
});
