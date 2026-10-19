#!/usr/bin/env node
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

// Keep this file dependency-free: consumers copy it into their repository.
const ignoredDirectories = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.output', '.cache', '.turbo',
])

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`)
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`Unknown ${label} key: ${key}`)
  }
}

function relativePath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':'))
    throw new Error(`${label} must be a portable repository-relative path`)
  if (value === '.') return value
  if (value.split('/').some((part) => !part || part === '.' || part === '..'))
    throw new Error(`${label} must not be absolute or contain empty, . or .. segments`)
  return value
}

function entries(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const seen = new Set()
  return value.map((entry) => {
    object(entry, ['path', 'reason'], `${label} entry`)
    const directory = relativePath(entry.path, `${label} path`)
    if (label === 'exclude' && directory === '.')
      throw new Error('exclude must not disable the entire repository')
    if (typeof entry.reason !== 'string' || !entry.reason.trim())
      throw new Error(`${label} entry needs a nonempty reason`)
    if (seen.has(directory)) throw new Error(`Duplicate ${label} path: ${directory}`)
    seen.add(directory)
    return directory
  })
}

function configuration(value) {
  object(value, ['warn', 'error', 'roots', 'exclude', 'exceptions'], 'configuration')
  const warn = value.warn === undefined ? 20 : value.warn
  const error = value.error === undefined ? 30 : value.error
  if (!Number.isSafeInteger(warn) || warn < 0)
    throw new Error('warn must be a nonnegative safe integer')
  if (!Number.isSafeInteger(error) || error <= warn)
    throw new Error('error must be a safe integer greater than warn')
  const roots = value.roots === undefined ? ['.'] : value.roots
  if (!Array.isArray(roots) || !roots.length)
    throw new Error('roots must be a nonempty array')
  return {
    warn,
    error,
    roots: roots.map((root) => relativePath(root, 'root')),
    exclude: entries(value.exclude === undefined ? [] : value.exclude, 'exclude'),
    exceptions: new Set(entries(value.exceptions === undefined ? [] : value.exceptions, 'exceptions')),
  }
}

function skipped(directory, config) {
  return directory.split('/').some((part) => ignoredDirectories.has(part)) ||
    config.exclude.some((excluded) => directory === excluded || directory.startsWith(`${excluded}/`))
}

async function verifyRoot(root) {
  // Inspect every component so an explicitly configured root cannot follow a symlink.
  const parts = root === '.' ? ['.'] : root.split('/')
  let current = process.cwd()
  for (const part of parts) {
    current = path.join(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`Root must be a directory without symlinks: ${root}`)
  }
}

async function scan(config) {
  const visited = new Set()
  const findings = []
  const pending = [...config.roots]
  for (const root of config.roots) await verifyRoot(root)
  while (pending.length) {
    const directory = pending.pop()
    if (visited.has(directory) || skipped(directory, config)) continue
    visited.add(directory)
    const children = await readdir(path.resolve(directory), { withFileTypes: true })
    const count = children.filter((entry) => entry.isFile()).length
    if (!config.exceptions.has(directory) && count > config.warn) {
      const level = count > config.error ? 'ERROR' : 'WARN'
      findings.push({ directory, count, level })
    }
    for (const entry of children) {
      if (entry.isDirectory())
        pending.push(directory === '.' ? entry.name : `${directory}/${entry.name}`)
    }
  }
  findings.sort((a, b) => a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0)
  for (const { directory, count, level } of findings) {
    const limit = level === 'ERROR' ? config.error : config.warn
    console.log(`${level} ${directory}: ${count} files (limit ${limit})`)
  }
  const errors = findings.filter((item) => item.level === 'ERROR').length
  const warnings = findings.length - errors
  console.log(`Directory size: ${visited.size} directories checked, ${warnings} warnings, ${errors} errors.`)
  return errors ? 1 : 0
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node check-directory-size.mjs [--config path]\n       node check-directory-size.mjs --help\nRun from the target repository root. Default config: directory-size.config.json\nExit codes: 0 = clean or warnings, 1 = directory errors, 2 = configuration or scan failure.')
    return 0
  }
  if (args.length && (args.length !== 2 || args[0] !== '--config' || !args[1] || args[1].startsWith('--')))
    throw new Error('Expected no arguments or --config path; use --help for usage')
  const configPath = args[1] ?? 'directory-size.config.json'
  const config = configuration(JSON.parse(await readFile(configPath, 'utf8')))
  return scan(config)
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(`Directory size check failed: ${error.message}`)
  process.exitCode = 2
}
