/**
 * Copyright (c) 2018-present, Maxim Andrews, maximandrews.com
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const Koa = require('koa');
const range = require('koa-range');
const proxy = require('koa-proxy');
const serve = require('koa-static');
const compress = require('koa-compress');
const fs = require('fs');
const c = require('chalk');
const url = require('url');
const path = require('path');
const debug = require('debug');
const address = require('address');
const chokidar = require('chokidar');
const inquirer = require('inquirer');
const EventEmitter = require('events');
const { createHash } = require('crypto');
const detectPort = require('detect-port-alt');
const { execSync } = require('child_process');
const escapeStringRegexp = require('escape-string-regexp');
const openBrowser = require('react-dev-utils/openBrowser');
const noopServiceWorkerMiddleware = require('noop-service-worker-middleware');

class WebpackKoaServer extends EventEmitter {
  constructor (options = {}) {
    super();

    const {
      template = undefined,
      env = [],
      host = '0.0.0.0',
      port = 3000,
      ssl = false, // { key, cert, pfx, passphrase }
      protocol = 'http', // http | http2
      content = [],
      open = true,
      appName = 'website',
      proxy = false, // { proxy config }
      addMiddleware = undefined
    } = options;

    this.template = path.resolve(template);
    this.envVars = env;
    this.host = host;
    this.defaultPort = port;
    this.open = open;
    this.content = typeof content === 'string' && content.length ? [content] : content;
    this.appName = appName;
    this.proxy = proxy;
    this.addMiddleware = addMiddleware;
    this.protocol = ssl ? 'https' : 'http';

    const serverPkg = require( protocol === 'http2' ? 'http2' : ( ssl ? 'https' : 'http' ) );
    const createServerMethod = protocol === 'http2' && ssl ? 'createSecureServer' : 'createServer';

    this.createServer = serverPkg[createServerMethod];
    this.address = address;
    this.url = url;

    this.fs = fs;
    this.createHash = createHash;
    this.escapeStringRegexp = escapeStringRegexp;

    this.detectPort = detectPort;
    this.openBrowser = openBrowser;

    this.isInteractive = process.stdout.isTTY;
    this.clearConsoleCode = process.platform === 'win32' ? '\x1B[2J\x1B[0f' : '\x1B[2J\x1B[3J\x1B[H';
    this.isFirstCompile = true;

    this.debug = debug('webpack-server');
    this.chokidar = chokidar;

    this.plugins = {};
    this.compiling = [];
    this.allStats = {
      errorsCount: 0,
      warningsCount: 0,
      messages: {}
    };

    this.updatingTemplate = false;
    this.templateUpdateQueue = [];

    this.middlewareList = {};

    // register listeners
    this.once('start-server', this.startServer.bind(this));

    this.on('load-template', this.loadTemplate.bind(this));
    this.on('refresh-template', this.refreshTemplate.bind(this));

    this.on('template-loaded', this.replaceEnvVars.bind(this));
    this.on('template-refreshed', this.replaceEnvVars.bind(this));

    this.on('compilation-invalid', this.compilationInvalid.bind(this));
    this.on('compilation-done', this.compilationDone.bind(this));

    this.templateWatcher = this.chokidar
      .watch( this.template, { ignored: /(^|[/\\])\../ })
      .on('change', this.loadTemplate.bind(this));
  }

  registerPlugin (plugin) {
    if (Object.values(this.plugins).indexOf(plugin) > -1) {
      return this.pluginIndex(plugin);
    }

    const newID = this.generateRandomId();

    this.plugins[newID] = plugin;

    return newID;
  }

  deRegisterPlugin (plugin) {
    const pluginIndex = typeof plugin === 'string' ? plugin : this.pluginIndex(plugin);

    if (pluginIndex) {
      delete this.plugins[pluginIndex];
    }
  }

  pluginIndex (plugin) {
    for (const idx in this.plugins) {
      if (this.plugins[idx] === plugin) {
        return idx;
      }
    }

    return false;
  }

  generateRandomId () {
    let randId, hash;

    do {
      randId = (Math.floor(Math.random() * 9999999999999999999999) + 1) + '_' + Date.now();

      hash = this.createHash('sha256');
      hash.update(randId);
      randId = hash.digest('hex').substring(0, 32);

    } while (this.plugins[randId]);

    return randId;
  }

  compilationInvalid (pluginId) {
    const idx = this.compiling.indexOf(pluginId);
    if (idx === -1) {
      this.compiling.push(pluginId);
    }

    if (this.isInteractive) {
      this.clearConsole();
    }
    console.log('Compiling...');
  }

  compilationDone (pluginId, messages) {
    const idx = this.compiling.indexOf(pluginId);
    if (idx > -1) {
      this.compiling.splice(idx, 1);
    }

    this.allStats.errorsCount += messages.errors.length;
    this.allStats.warningsCount += messages.warnings.length;
    this.allStats.messages[pluginId] = messages;

    if (this.compiling.length === 0) {
      this.flushStats();
      this.emit('all-compilled');
    }
  }

  flushStats () {
    if (this.isInteractive) {
      this.clearConsole();
    }

    const isSuccessful = !this.allStats.errorsCount && !this.allStats.warningsCount;
    if (isSuccessful) {
      console.log(c.green('Compiled successfully!'));
    }
    if (isSuccessful && (this.isInteractive || this.isFirstCompile)) {
      this.printConsoleInstructions(this.appName);
    }
    this.isFirstCompile = false;

    let printHints = false;

    const pluginId = Object.keys(this.allStats.messages).shift();
    const messages = this.allStats.messages[pluginId];
    const configName = this.plugins[pluginId].compiler.options.name;

    // If errors exist, only show errors.
    if (messages.errors.length) {
      // Only keep the first error. Others are often indicative
      // of the same problem, but confuse the reader with noise.
      if (messages.errors.length > 1) {
        messages.errors.length = 1;
      }
      console.log(c.red(`Compilation ${c.bold(configName)} failed to compile.\n`));
      console.log(messages.errors.join('\n\n'));
      return;
    }

    // Show warnings if no errors were found.
    if (messages.warnings.length) {
      console.log(c.yellow(`Compilation ${c.bold(configName)} compiled with warnings.\n`));
      console.log(messages.warnings.join('\n\n'));

      if (printHints) {
        // Teach some ESLint tricks.
        console.log(
          '\nSearch for the ' +
            c.underline(c.yellow('keywords')) +
            ' to learn more about each warning.'
        );
        console.log(
          'To ignore, add ' +
            c.cyan('// eslint-disable-next-line') +
            ' to the line before.\n'
        );
      }
    }

    this.allStats = {
      errorsCount: 0,
      warningsCount: 0,
      messages: {}
    };
  }

  loadTemplate () {
    if (!this.template) {
      throw Error('WebpackKoaServer `template` option is required.');
    }

    this.originalTemplateHtml = this.templateHtml = this.fs.readFileSync(this.template, 'utf8');
    this.replaceEnvVars();
    this.emit('template-loaded');
  }

  refreshTemplate () {
    if (!this.originalTemplateHtml) {
      return this.loadTemplate();
    }

    this.templateHtml = this.originalTemplateHtml;
    this.replaceEnvVars();
    this.emit('template-refreshed');
  }

  replaceEnvVars () {
    Object.keys(this.envVars).forEach(key => {
      const value = this.envVars[key];
      this.templateHtml = this.templateHtml.replace(
        new RegExp('%' + this.escapeStringRegexp(key) + '%', 'g'),
        value
      );
    });
  }

  updateTemplate () {
    if (this.updatingTemplate) {
      return new Promise(resolve => {
        this.templateUpdateQueue.push(resolve);
      });
    }

    this.updatingTemplate = true;

    return Promise.resolve({
      templateHtml: this.templateHtml,
      callback: this.finishTemplateUpdate.bind(this)
    });
  }

  finishTemplateUpdate (templateHtml) {
    this.templateHtml = templateHtml;

    if (this.templateUpdateQueue.length) {
      const next = this.templateUpdateQueue.shift();
      return next({
        templateHtml: this.templateHtml,
        callback: this.finishTemplateUpdate.bind(this)
      });
    }

    this.updatingTemplate = false;

    this.emit('template-updated', this.templateHtml);
  }

  appendMiddleware (middleware, priority) {
    while (this.middlewareList[priority]) {
      priority++;
    }

    this.middlewareList[priority] = middleware;
  }

  applyMiddleware () {
    const priorities = Object
      .keys(this.middlewareList)
      .sort((a, b) => a - b);

    priorities.forEach(priority => {
      const middleware = this.middlewareList[priority];
      this.koa.use(middleware());
    });
  }

  reStartServer () {
    if (!this.rawServer) {
      return this.startServer();
    }

    if (this.isInteractive) {
      this.clearConsole();
    }
    console.log('Restarting WebpackKoaServer...');

    this.rawServer.close(() => {
      this.startServer();
    });
  }

  async startServer () {
    if (this.rawServer) {
      throw Error('WebpackKoaServer is already running.');
    }

    this.rawServer = true;

    this.port = await this.choosePort();
    this.urls = this.prepareUrls();
    this.koa = new Koa();

    // This service worker file is effectively a 'no-op' that will reset any
    // previous service worker registered for the same host:port combination.
    // We do this in development to avoid hitting the production cache if
    // it used the same host and port.
    // https://github.com/facebookincubator/create-react-app/issues/2272#issuecomment-302832432
    this.koa.use(noopServiceWorkerMiddleware());

    // compressed output
    this.koa.use(compress());

    // handle range header
    this.koa.use(range);

    if (Array.isArray(this.content)) {
      this.content.forEach(folder => {
        this.koa.use(serve(path.resolve(folder), { defer: true }));
      });
    }

    if (typeof this.proxy === 'object' && Object.keys(this.proxy).length > 0) {
      this.koa.use(proxy(this.proxy));
    }

    this.applyMiddleware();

    if (typeof this.addMiddleware === 'function') {
      this.addMiddleware(this.koa);
    }

    this.rawServer = this.createServer(this.koa.callback());

    this.rawServer.on('listening', this.onServerListen.bind(this));

    this.rawServer.listen(this.port);
  }

  onServerListen () {
    ['SIGINT', 'SIGTERM'].forEach(sig => {
      process.on(sig, () => {
        this.rawServer.close();
        if (this.templateWatcher && typeof this.templateWatcher.close === 'function') {
          this.templateWatcher.close();
        }
        process.exit();
      });
    });

    if (this.isInteractive) {
      this.clearConsole();
    }

    console.log(c.cyan('Starting the development server...\n'));

    if (this.open) {
      this.openBrowser(this.urls.localUrlForBrowser);
    }
  }

  printConsoleInstructions (appName) {
    console.log();
    console.log(`You can now view ${c.bold(appName)} in the browser.`);
    console.log();

    if (this.urls.lanUrlForTerminal) {
      console.log(
        `  ${c.bold('Local:')}            ${this.urls.localUrlForTerminal}`
      );
      console.log(
        `  ${c.bold('On Your Network:')}  ${this.urls.lanUrlForTerminal}`
      );
    } else {
      console.log(`  ${this.urls.localUrlForTerminal}`);
    }

    console.log();
    console.log('Note that the development build is not optimized.');
    console.log(
      `To create a production build, use ${c.cyan('npm run build')}.`
    );
    console.log();
  }

  async choosePort () {
    const port = await this.detectPort(this.defaultPort, this.host);

    return new Promise((resolve, reject) => {
      if (port === this.defaultPort) {
        return resolve(port);
      }

      const message =
        process.platform !== 'win32' && this.defaultPort < 1024 && !this.isRoot()
          ? 'Administrator privileges are required to run a server on a port below 1024.'
          : `Some service is already running on port ${this.defaultPort}.`;

      if (this.isInteractive) {
        this.clearConsole();
        const runningProcess = this.processNameByPort(this.defaultPort);
        const question = {
          type: 'confirm',
          name: 'changePort',
          message:
            c.yellow(
              message +
              `${runningProcess ? ` Probably:\n  ${runningProcess}` : ''}`
            ) + '\n\nWould you like to run the app on another port instead?',
          default: true,
        };
        inquirer.prompt(question).then(answer => {
          if (answer.changePort) {
            resolve(port);
          } else {
            reject(c.red(message));
          }
        });
      } else {
        reject(c.red(message));
      }
    });
  }

  processNameByPort (port) {
    const execOptions = {
      encoding: 'utf8',
      stdio: [
        'pipe', // stdin (default)
        'pipe', // stdout (default)
        'ignore', //stderr
      ],
    };

    try {
      const processIdViaPortCmd = `lsof -i:${port} -P -t -sTCP:LISTEN`;
      const processId = execSync(processIdViaPortCmd, execOptions).split('\n').shift().trim();
      const directoryCmd = `lsof -p ${processId} | awk '$4=="cwd" {for (i=9; i<=NF; i++) printf "%s ", $i}'`;
      const directory = execSync(directoryCmd, execOptions).trim();
      const processCommandById = `ps -o command -p ${processId} | sed -n 2p`;
      const command = execSync(processCommandById, execOptions).replace(/\n$/, '');
      const fullstackApp = /^node .*fullstack-scripts\/scripts\/start\.js\s?$/.test(command);
      const cmdName = (fullstackApp && this.pkgNameByDir(directory)) || command;

      return `${c.cyan(cmdName)} ${c.grey(`(pid ${processId})`)} ${c.blue('in')} ${c.cyan(directory)}`;
    } catch (e) {
      return null;
    }
  }

  pkgNameByDir (dir) {
    try {
      return require(path.join(dir, 'package.json')).name;
    } catch (e) {
      return false;
    }
  }

  prepareUrls () {
    const isUnspecifiedHost = this.host === '0.0.0.0' || this.host === '::';
    let prettyHost, lanUrlForConfig, lanUrlForTerminal;
    if (isUnspecifiedHost) {
      prettyHost = 'localhost';
      try {
        // This can only return an IPv4 address
        lanUrlForConfig = this.address.ip();
        if (lanUrlForConfig) {
          // Check if the address is a private ip
          // https://en.wikipedia.org/wiki/Private_network#Private_IPv4_address_spaces
          if (
            /^10[.]|^172[.](1[6-9]|2[0-9]|3[0-1])[.]|^192[.]168[.]/.test(
              lanUrlForConfig
            )
          ) {
            // Address is private, format it for later use
            lanUrlForTerminal = this.prettyPrintUrl(lanUrlForConfig);
          } else {
            // Address is not private, so we will discard it
            lanUrlForConfig = undefined;
          }
        }
      } catch (_e) {
        // ignored
      }
    } else {
      prettyHost = this.host;
    }

    const localUrlForTerminal = this.prettyPrintUrl(prettyHost);
    const localUrlForBrowser = this.formatUrl(prettyHost);
    return {
      lanUrlForConfig,
      lanUrlForTerminal,
      localUrlForTerminal,
      localUrlForBrowser,
    };
  }

  formatUrl (hostname) {
    return this.url.format({
      protocol: this.protocol,
      hostname,
      port: this.port,
      pathname: '/',
    });
  }

  prettyPrintUrl (hostname) {
    return this.url.format({
      protocol: this.protocol,
      hostname,
      port: c.bold(this.port),
      pathname: '/',
    });
  }

  clearConsole () {
    process.stdout.write(this.clearConsoleCode);
  }

  isRoot () {
    return typeof process.getuid === 'function' && process.getuid() === 0;
  }
}

module.exports = WebpackKoaServer;