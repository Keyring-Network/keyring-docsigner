import http from 'http';
import { ParseServer } from 'parse-server';

export const dropDB = async () => {
  await Parse.User.logOut();
  return await Parse.Server.database.deleteEverything(true);
};
let parseServerState = {};

function ensureTestEnv() {
  process.env.APP_ID = process.env.APP_ID || 'test';
  process.env.MASTER_KEY = process.env.MASTER_KEY || 'test';
  process.env.SERVER_URL = process.env.SERVER_URL || 'http://localhost:30001/test';
  process.env.USE_LOCAL = process.env.USE_LOCAL || 'true';
}

function testDatabaseURI() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/parse-test';
  return uri.endsWith('/') ? `${uri}parse-test` : uri;
}

/**
 * Starts the ParseServer instance
 * @param {Object} parseServerOptions Used for creating the `ParseServer`
 * @return {Promise} Runner state
 */
export async function startParseServer() {
  ensureTestEnv();
  const { app, config } = await import('../../index.js');
  delete config.databaseAdapter;
  const parseServerOptions = Object.assign(config, {
    databaseURI: testDatabaseURI(),
    masterKey: 'test',
    javascriptKey: 'test',
    appId: 'test',
    port: 30001,
    mountPath: '/test',
    serverURL: `http://localhost:30001/test`,
    logLevel: 'error',
    silent: true,
  });
  const parseServer = new ParseServer(parseServerOptions);
  await parseServer.start();
  app.use(parseServerOptions.mountPath, parseServer.app);
  const httpServer = http.createServer(app);
  await new Promise(resolve => httpServer.listen(parseServerOptions.port, resolve));
  Object.assign(parseServerState, {
    parseServer,
    httpServer,
    parseServerOptions,
  });
  return parseServerOptions;
}

/**
 * Stops the ParseServer instance
 * @return {Promise}
 */
export async function stopParseServer() {
  if (parseServerState.httpServer) {
    await new Promise(resolve => parseServerState.httpServer.close(resolve));
  }
  await parseServerState.parseServer?.stop?.();
  parseServerState = {};
}
