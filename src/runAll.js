'use strict'

const chalk = require('chalk')
const dedent = require('dedent')
const Listr = require('listr')
const has = require('lodash/has')
const symbols = require('log-symbols')

const generateTasks = require('./generateTasks')
const getStagedFiles = require('./getStagedFiles')
const git = require('./gitWorkflow')
const makeCmdTasks = require('./makeCmdTasks')
const resolveGitDir = require('./resolveGitDir')

const debug = require('debug')('lint-staged:run')

/**
 * https://serverfault.com/questions/69430/what-is-the-maximum-length-of-a-command-line-in-mac-os-x
 * https://support.microsoft.com/en-us/help/830473/command-prompt-cmd-exe-command-line-string-limitation
 * https://unix.stackexchange.com/a/120652
 */
const MAX_ARG_LENGTH =
  (process.platform === 'darwin' && 262144) || (process.platform === 'win32' && 8191) || 131072

/**
 * Executes all tasks and either resolves or rejects the promise
 * @param config {Object}
 * @returns {Promise}
 */
module.exports = async function runAll(config) {
  debug('Running all linter scripts')
  // Config validation
  if (!config || !has(config, 'concurrent') || !has(config, 'renderer')) {
    throw new Error('Invalid config provided to runAll! Use getConfig instead.')
  }

  const { concurrent, renderer } = config
  const gitDir = await resolveGitDir(config)

  if (!gitDir) {
    throw new Error('Current directory is not a git directory!')
  }

  debug('Resolved git directory to be `%s`', gitDir)

  const files = await getStagedFiles({ cwd: gitDir })

  if (!files) {
    throw new Error('Unable to get staged files!')
  }

  debug('Loaded list of staged files in git:\n%O', files)

  const argLength = files.join(' ').length
  if (argLength > MAX_ARG_LENGTH) {
    console.warn(
      dedent`${symbols.warning}  ${chalk.yellow(
        `lint-staged generated an argument string of ${argLength} characters, and commands might not run correctly on your platform.
It is recommended to use functions as linters and split your command based on the number of staged files. For more info, please read:
https://github.com/okonet/lint-staged#using-js-functions-to-customize-linter-commands
        `
      )}`
    )
  }

  const tasks = (await generateTasks(config, gitDir, files)).map(task => ({
    title: `Running tasks for ${task.pattern}`,
    task: async () =>
      new Listr(await makeCmdTasks(task.commands, gitDir, task.fileList), {
        // In sub-tasks we don't want to run concurrently
        // and we want to abort on errors
        dateFormat: false,
        concurrent: false,
        exitOnError: true
      }),
    skip: () => {
      if (task.fileList.length === 0) {
        return `No staged files match ${task.pattern}`
      }
      return false
    }
  }))

  const listrBaseOptions = {
    dateFormat: false,
    renderer
  }

  // If all of the configured "linters" should be skipped
  // avoid executing any lint-staged logic
  if (tasks.every(task => task.skip())) {
    console.log('No staged files match any of provided globs.')
    return 'No tasks to run.'
  }

  // Do not terminate main Listr process on SIGINT
  process.on('SIGINT', () => {})

  return new Listr(
    [
      {
        title: 'Stashing changes...',
        skip: async () => {
          const hasPSF = await git.hasPartiallyStagedFiles({ cwd: gitDir })
          if (!hasPSF) {
            return 'No partially staged files found...'
          }
          return false
        },
        task: ctx => {
          ctx.hasStash = true
          return git.gitStashSave({ cwd: gitDir })
        }
      },
      {
        title: 'Running linters...',
        task: () =>
          new Listr(tasks, {
            ...listrBaseOptions,
            concurrent,
            exitOnError: !concurrent
          })
      },
      {
        title: 'Updating stash...',
        enabled: ctx => ctx.hasStash,
        skip: ctx => ctx.hasErrors && 'Skipping stash update since some tasks exited with errors',
        task: () => git.updateStash({ cwd: gitDir })
      },
      {
        title: 'Restoring local changes...',
        enabled: ctx => ctx.hasStash,
        task: () => git.gitStashPop({ cwd: gitDir })
      }
    ],
    listrBaseOptions
  ).run()
}
