/**
 * Copyright (c) 2018-present, Maxim Andrews, maximandrews.com
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

const path = require('path');

// Do this as the first thing so that any code reading it knows the right env.
process.env.BABEL_ENV = 'test';
process.env.NODE_ENV = 'test';
process.env.PUBLIC_URL = '';

// Makes the script crash on unhandled rejections instead of silently
// ignoring them. In the future, promise rejections that are not handled will
// terminate the Node.js process with a non-zero exit code.
process.on('unhandledRejection', err => {
  throw err;
});

// Ensure environment variables are read.
require('../config/env');

const jest = require('jest');
const execSync = require('child_process').execSync;
const execVC = cmd => {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
};
const hasGit = () => execVC('git rev-parse --is-inside-work-tree');
const hasMercurial = () => execVC('hg --cwd . root');

let argv = process.argv.slice(2);

// Watch unless on CI or in coverage mode
if (!process.env.CI
    && argv.indexOf('--coverage') < 0
    && argv.indexOf('--watchAll') === -1
    && argv.indexOf('--watchAll=false') === -1) {
  const versioned = hasGit() || hasMercurial();
  argv.push(versioned ? '--watch' : '--watchAll');
}

const createJestConfig = require('../config/jest/jestConfig');
const paths = require('../config/paths');
argv.push(
  '--config',
  JSON.stringify(
    createJestConfig(
      relativePath => path.resolve(__dirname, '..', relativePath),
      path.resolve(paths.appSrc, '..'),
      false
    )
  )
);

// This is a very dirty workaround for https://github.com/facebook/jest/issues/5913.
// We're trying to resolve the environment ourselves because Jest does it incorrectly.
// TODO: remove this (and the `resolve` dependency) as soon as it's fixed in Jest.
const resolve = require('resolve');
function resolveJestDefaultEnvironment(name) {
  const jestDir = path.dirname(
    resolve.sync('jest', {
      basedir: __dirname,
    })
  );
  const jestCLIDir = path.dirname(
    resolve.sync('jest-cli', {
      basedir: jestDir,
    })
  );
  const jestConfigDir = path.dirname(
    resolve.sync('jest-config', {
      basedir: jestCLIDir,
    })
  );
  return resolve.sync(name, {
    basedir: jestConfigDir,
  });
}
let cleanArgv = [];
let env = 'node';
let next;
do {
  next = argv.shift();
  if (next === '--env') {
    env = argv.shift();
  } else if (next.indexOf('--env=') === 0) {
    env = next.substring('--env='.length);
  } else {
    cleanArgv.push(next);
  }
} while (argv.length > 0);
argv = cleanArgv;
let resolvedEnv;
try {
  resolvedEnv = resolveJestDefaultEnvironment(`jest-environment-${env}`);
} catch (e) {
  // ignore
}
if (!resolvedEnv) {
  try {
    resolvedEnv = resolveJestDefaultEnvironment(env);
  } catch (e) {
    // ignore
  }
}
const testEnvironment = resolvedEnv || env;
argv.push('--env', testEnvironment);
jest.run(argv);
