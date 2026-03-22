const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const dataDir = process.env.COS_DATA_DIR || './data';
const tokensFile = path.resolve(dataDir, 'tokens.json');

const tokenStore = new Map();

const envToken = process.env.COS_TOKEN;
const envTokenTenant = 'default';

function loadTokens() {
  try {
    if (fs.existsSync(tokensFile)) {
      const data = JSON.parse(fs.readFileSync(tokensFile, 'utf-8'));
      if (data.tokens && Array.isArray(data.tokens)) {
        data.tokens.forEach(tokenInfo => {
          tokenStore.set(tokenInfo.token, tokenInfo);
        });
        console.log(`Loaded ${tokenStore.size} tokens from disk`);
      }
    }
  } catch (err) {
    console.error('Error loading tokens from disk:', err.message);
  }
}

function saveTokens() {
  try {
    const dir = path.dirname(tokensFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const data = {
      tokens: Array.from(tokenStore.values()),
      updatedAt: new Date().toISOString()
    };

    fs.writeFileSync(tokensFile, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving tokens to disk:', err.message);
  }
}

function generateToken() {
  const token = uuidv4();
  const tenantId = uuidv4();
  const tokenInfo = {
    token,
    tenantId,
    createdAt: new Date().toISOString()
  };
  tokenStore.set(token, tokenInfo);
  saveTokens();
  return tokenInfo;
}

function getTokenInfo(token) {
  if (!token) {
    return null;
  }
  if (envToken && token === envToken) {
    return {
      token,
      tenantId: envTokenTenant,
      createdAt: new Date().toISOString(),
      isEnvToken: true
    };
  }
  return tokenStore.get(token) || null;
}

function validateToken(token) {
  return getTokenInfo(token) !== null;
}

function revokeToken(token) {
  const result = tokenStore.delete(token);
  if (result) {
    saveTokens();
  }
  return result;
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : req.headers['x-cos-token'] || req.query?.token;

  const tokenInfo = getTokenInfo(token);

  if (!tokenInfo) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: 'Unauthorized',
      message: 'Invalid or missing authentication token',
      code: 'InvalidToken'
    }));
    next(false);
    return;
  }

  req.tokenInfo = tokenInfo;
  next(true);
}

function listTokens() {
  return Array.from(tokenStore.values());
}

loadTokens();

module.exports = {
  generateToken,
  validateToken,
  revokeToken,
  getTokenInfo,
  authMiddleware,
  listTokens,
  loadTokens,
  saveTokens
};
