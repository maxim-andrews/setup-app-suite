/**
 * Copyright (c) 2018, Maxim Andrews, MaximAndrews.com
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const url = require('url');

// Make sure any symlinks in the project folder are resolved:
// https://github.com/facebookincubator/create-react-app/issues/637
const appDirectory = fs.realpathSync(process.cwd());
const resolveApp = relativePath => path.resolve(appDirectory, relativePath);
const appPkgJsn = require(resolveApp('package.json'));

const envPublicUrl = process.env.PUBLIC_URL;

function ensureSlash(path, needsSlash) {
  const hasSlash = path.endsWith('/');
  if (hasSlash && !needsSlash) {
    return path.substring(0, path.length - 1);
  } else if (!hasSlash && needsSlash) {
    return `${ path }/`;
  } else {
    return path;
  }
}

const getPublicUrl = appPkgJsn =>
  envPublicUrl || appPkgJsn.homepage;

// We use `PUBLIC_URL` environment variable or "homepage" field to infer
// "public path" at which the app is served.
// Webpack needs to know it to put the right <script> hrefs into HTML even in
// single-page apps that may serve index.html for nested URLs like /todos/42.
// We can't use a relative path in HTML because we don't want to load something
// like /todos/42/static/js/bundle.7289d.js. We have to know the root.
function getServedPath(appPkgJsn) {
  const publicUrl = getPublicUrl(appPkgJsn);
  const servedUrl =
    envPublicUrl || (publicUrl ? url.parse(publicUrl).pathname : '/');
  return ensureSlash(servedUrl, true);
}

const resolveOwn = relativePath => path.resolve(__dirname, '..', relativePath);

// we're in ./node_modules/fullstack-scripts/config/
const paths = {
  dotenv: resolveApp('.env'),
  appPath: resolveApp('.'),
  appBuild: resolveApp('build'),
  appPublic: resolveApp('public'),
  appHtml: resolveApp('public/index.html'),
  appIndexJs: resolveApp('src/index.js'),
  appPackageJson: resolveApp('package.json'),
  appSrc: resolveApp('src'),
  yarnLockFile: resolveApp('yarn.lock'),
  testsSetup: resolveApp('src/setupTests.js'),
  appNodeModules: resolveApp('node_modules'),
  publicUrl: getPublicUrl(appPkgJsn),
  servedPath: getServedPath(appPkgJsn),
  ownPath: resolveOwn('.'),
  ownNodeModules: resolveOwn('node_modules'), // This is empty on npm 3
};

if (appPkgJsn.serverSideRendering) {
  const ssrCfg = appPkgJsn.serverSideRendering;

  paths.appBuild = resolveApp(ssrCfg.client || 'build/client');
  paths.appBuildSsr = resolveApp(ssrCfg.buildPath || 'build/ssr');
  paths.appSsrIndexJs = resolveApp(ssrCfg.srcPath || 'src/server.side.renderer.js');
}

module.exports = paths;