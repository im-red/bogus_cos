const http = require('http');
const fs = require('fs');
const path = require('path');
const { authMiddleware, generateToken, revokeToken, getTokenInfo, listTokens } = require('./auth');
const { handleBucketOperations, handleObjectOperations, handleServiceRequest } = require('./routes');
const storage = require('./storage');

const config = {
  port: process.env.COS_PORT || 9000,
  host: process.env.COS_HOST || '0.0.0.0',
  enableAuth: process.env.COS_ENABLE_AUTH !== 'false',
  dataDir: process.env.COS_DATA_DIR || './data',
  portalPath: process.env.COS_PORTAL_PATH || path.join(__dirname, '..', 'public', 'index.html')
};

function parsePath(pathname) {
  const parts = pathname.split('/').filter(Boolean);

  if (parts.length === 0) {
    return { type: 'service' };
  }

  if (parts.length === 1) {
    return { type: 'bucket', bucketName: parts[0] };
  }

  return {
    type: 'object',
    bucketName: parts[0],
    objectKey: parts.slice(1).join('/')
  };
}

async function handleRequest(req, res) {
  const [pathnameRaw, searchString] = req.url.split('?');
  const pathname = decodeURIComponent(pathnameRaw);
  const pathInfo = parsePath(pathname);
  req.query = searchString ? Object.fromEntries(new URLSearchParams(searchString)) : {};

  if (pathname === '/__auth/token' && req.method === 'POST') {
    const tokenInfo = generateToken();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      token: tokenInfo.token,
      tenantId: tokenInfo.tenantId,
      createdAt: tokenInfo.createdAt
    }));
    return;
  }

  if (pathname === '/__auth/tokens' && req.method === 'GET') {
    const tokens = listTokens();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ tokens }));
    return;
  }

  if (pathname === '/__stats' && req.method === 'GET') {
    const stats = storage.getStats();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(stats));
    return;
  }

  if (pathname === '/__portal' || pathname === '/portal') {
    try {
      const html = fs.readFileSync(config.portalPath, 'utf8');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    } catch (err) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Portal not found', message: err.message }));
    }
    return;
  }

  if (config.enableAuth) {
    await new Promise((resolve) => {
      authMiddleware(req, res, resolve);
    });
    if (res.headersSent) return;
  }

  if (pathInfo.type === 'service') {
    await handleServiceRequest(req, res);
    return;
  }

  if (pathInfo.type === 'bucket') {
    await handleBucketOperations(req, res, pathInfo.bucketName);
    return;
  }

  if (pathInfo.type === 'object') {
    await handleObjectOperations(req, res, pathInfo.bucketName, pathInfo.objectKey);
    return;
  }

  res.statusCode = 404;
  res.end();
}

function createServer() {
  const server = http.createServer(handleRequest);
  return server;
}

function startServer(port = config.port, host = config.host) {
  const server = createServer();

  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      console.log(`Bogus COS Mock Server started at http://${host}:${port}`);
      console.log(`Authentication: ${config.enableAuth ? 'Enabled' : 'Disabled'}`);
      console.log(`Data directory: ${storage.dataDir}`);
      resolve(server);
    });

    server.on('error', reject);
  });
}

function setupGracefulShutdown(server) {
  const shutdown = () => {
    console.log('\nShutting down gracefully...');
    storage.flush();
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });

    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, 5000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function createServerlessHandler() {
  return async (event, context) => {
    const req = {
      method: event.httpMethod || event.method || 'GET',
      headers: event.headers || {},
      url: event.path || event.url || '/',
      body: event.body,
      on: (name, callback) => {
        if (name === 'data' && event.body) {
          callback(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf-8'));
        }
        if (name === 'end') {
          callback();
        }
      }
    };

    let responseBody = '';
    let statusCode = 200;
    let responseHeaders = {};

    const res = {
      setHeader: (key, value) => {
        responseHeaders[key] = value;
      },
      end: (body) => {
        responseBody = body || '';
      }
    };

    Object.defineProperty(res, 'statusCode', {
      set: (val) => { statusCode = val; },
      get: () => statusCode
    });

    Object.defineProperty(res, 'headersSent', {
      get: () => false
    });

    await handleRequest(req, res);

    return {
      statusCode,
      headers: responseHeaders,
      body: responseBody,
      isBase64Encoded: false
    };
  };
}

module.exports = {
  createServer,
  startServer,
  setupGracefulShutdown,
  createServerlessHandler,
  storage,
  auth: {
    generateToken,
    revokeToken,
    getTokenInfo,
    listTokens
  },
  config
};

if (require.main === module) {
  startServer()
    .then(server => {
      setupGracefulShutdown(server);
    })
    .catch(console.error);
}
