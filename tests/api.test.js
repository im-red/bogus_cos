const http = require('http');
const { createServer } = require('../src/index');
const { loadTokens, saveTokens } = require('../src/auth');
const storage = require('../src/storage');
const fs = require('fs');
const path = require('path');

// Test configuration
const TEST_PORT = 9999;
const TEST_DATA_DIR = path.join(__dirname, 'test-data');

// Helper function to make HTTP requests
function makeRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: TEST_PORT,
      ...options
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: data,
          json: () => {
            try {
              return JSON.parse(data);
            } catch (e) {
              return null;
            }
          }
        });
      });
    });

    req.on('error', reject);

    if (body) {
      if (Buffer.isBuffer(body)) {
        req.write(body);
      } else {
        req.write(JSON.stringify(body));
      }
    }

    req.end();
  });
}

// Test suite
class TestSuite {
  constructor() {
    this.server = null;
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
    this.tokens = [];
  }

  async setup() {
    // Clean up test data directory
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

    // Set environment variables
    process.env.COS_DATA_DIR = TEST_DATA_DIR;
    process.env.COS_PORT = TEST_PORT;
    process.env.COS_ENABLE_AUTH = 'true';

    // Clear token store and storage
    storage.tenants.clear();
    storage.dataDir = TEST_DATA_DIR;

    // Start server
    this.server = createServer();
    await new Promise((resolve) => {
      this.server.listen(TEST_PORT, resolve);
    });

    console.log(`Test server started on port ${TEST_PORT}`);
  }

  async teardown() {
    if (this.server) {
      this.server.close();
    }

    // Clean up test data
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }

    console.log('\nTest Results:');
    console.log(`  Passed: ${this.passed}`);
    console.log(`  Failed: ${this.failed}`);
    console.log(`  Total: ${this.passed + this.failed}`);
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  async run() {
    for (const { name, fn } of this.tests) {
      try {
        await fn();
        console.log(`✓ ${name}`);
        this.passed++;
      } catch (error) {
        console.log(`✗ ${name}`);
        console.log(`  Error: ${error.message}`);
        this.failed++;
      }
    }
  }

  assertEqual(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(`${message}: expected ${expected}, got ${actual}`);
    }
  }

  assertTrue(value, message) {
    if (!value) {
      throw new Error(message || 'Expected true but got false');
    }
  }

  assertFalse(value, message) {
    if (value) {
      throw new Error(message || 'Expected false but got true');
    }
  }
}

const suite = new TestSuite();

// ============================================
// Admin/Utility API Tests
// ============================================

suite.test('POST /__internal__/auth/token - Generate new token (200)', async () => {
  const res = await makeRequest({
    method: 'POST',
    path: '/__internal__/auth/token'
  });

  suite.assertEqual(res.status, 200, 'Status code');
  const json = res.json();
  suite.assertTrue(json.token, 'Response has token');
  suite.assertTrue(json.tenantId, 'Response has tenantId');
  suite.assertTrue(json.createdAt, 'Response has createdAt');

  // Store token for later tests
  suite.tokens.push(json.token);
});

suite.test('GET /__internal__/auth/tokens - List all tokens (200)', async () => {
  const res = await makeRequest({
    method: 'GET',
    path: '/__internal__/auth/tokens'
  });

  suite.assertEqual(res.status, 200, 'Status code');
  const json = res.json();
  suite.assertTrue(Array.isArray(json.tokens), 'Response has tokens array');
  suite.assertTrue(json.tokens.length >= 1, 'Has at least one token');
});

suite.test('DELETE /__internal__/auth/token - Delete existing token (200)', async () => {
  // Generate a token first
  const genRes = await makeRequest({
    method: 'POST',
    path: '/__internal__/auth/token'
  });
  const token = genRes.json().token;

  // Delete the token
  const res = await makeRequest({
    method: 'DELETE',
    path: `/__internal__/auth/token?token=${encodeURIComponent(token)}`
  });

  suite.assertEqual(res.status, 200, 'Status code');
  suite.assertEqual(res.json().success, true, 'Response success');
});

suite.test('DELETE /__internal__/auth/token - Missing token parameter (400)', async () => {
  const res = await makeRequest({
    method: 'DELETE',
    path: '/__internal__/auth/token'
  });

  suite.assertEqual(res.status, 400, 'Status code');
  suite.assertEqual(res.json().error, 'BadRequest', 'Error code');
});

suite.test('DELETE /__internal__/auth/token - Non-existent token (404)', async () => {
  const res = await makeRequest({
    method: 'DELETE',
    path: `/__internal__/auth/token?token=${encodeURIComponent('non-existent-token')}`
  });

  suite.assertEqual(res.status, 404, 'Status code');
  suite.assertEqual(res.json().error, 'NotFound', 'Error code');
});

suite.test('GET /__internal__/stats - Get server statistics (200)', async () => {
  const res = await makeRequest({
    method: 'GET',
    path: '/__internal__/stats'
  });

  suite.assertEqual(res.status, 200, 'Status code');
  const json = res.json();
  suite.assertTrue(typeof json.tenants === 'number', 'Has tenants count');
  suite.assertTrue(typeof json.totalBuckets === 'number', 'Has buckets count');
  suite.assertTrue(typeof json.totalObjects === 'number', 'Has objects count');
});

suite.test('GET /__internal__/portal - Get portal page (200)', async () => {
  const res = await makeRequest({
    method: 'GET',
    path: '/__internal__/portal'
  });

  suite.assertEqual(res.status, 200, 'Status code');
  suite.assertEqual(res.headers['content-type'], 'text/html; charset=utf-8', 'Content-Type');
  suite.assertTrue(res.data.includes('<!DOCTYPE html>'), 'Response is HTML');
});

suite.test('GET /portal - Get portal page alias (200)', async () => {
  const res = await makeRequest({
    method: 'GET',
    path: '/portal'
  });

  suite.assertEqual(res.status, 200, 'Status code');
});

suite.test('OPTIONS / - CORS preflight (204)', async () => {
  const res = await makeRequest({
    method: 'OPTIONS',
    path: '/'
  });

  suite.assertEqual(res.status, 204, 'Status code');
  suite.assertEqual(res.headers['access-control-allow-origin'], '*', 'CORS origin');
});

// ============================================
// Authentication Tests
// ============================================

suite.test('GET / - No auth header (401)', async () => {
  const res = await makeRequest({
    method: 'GET',
    path: '/'
  });

  suite.assertEqual(res.status, 401, 'Status code');
  suite.assertEqual(res.json().error, 'Unauthorized', 'Error code');
});

suite.test('GET / - Invalid Bearer token (401)', async () => {
  const res = await makeRequest({
    method: 'GET',
    path: '/',
    headers: {
      'Authorization': 'Bearer invalid-token'
    }
  });

  suite.assertEqual(res.status, 401, 'Status code');
});

suite.test('GET / - Invalid X-Cos-Token header (401)', async () => {
  const res = await makeRequest({
    method: 'GET',
    path: '/',
    headers: {
      'X-Cos-Token': 'invalid-token'
    }
  });

  suite.assertEqual(res.status, 401, 'Status code');
});

suite.test('GET / - Valid Bearer token (200)', async () => {
  // Generate a token
  const genRes = await makeRequest({
    method: 'POST',
    path: '/__internal__/auth/token'
  });
  const token = genRes.json().token;

  const res = await makeRequest({
    method: 'GET',
    path: '/',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 200, 'Status code');
  suite.assertTrue(res.data.includes('ListAllMyBucketsResult'), 'Response is XML bucket list');
});

suite.test('GET / - Token in query string (200)', async () => {
  // Generate a token
  const genRes = await makeRequest({
    method: 'POST',
    path: '/__internal__/auth/token'
  });
  const token = genRes.json().token;

  const res = await makeRequest({
    method: 'GET',
    path: `/?token=${encodeURIComponent(token)}`
  });

  suite.assertEqual(res.status, 200, 'Status code');
});

// ============================================
// Service API Tests (List Buckets)
// ============================================

suite.test('GET / - List buckets (200)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'GET',
    path: '/',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 200, 'Status code');
  suite.assertEqual(res.headers['content-type'], 'application/xml', 'Content-Type');
  suite.assertTrue(res.data.includes('ListAllMyBucketsResult'), 'Response has ListAllMyBucketsResult');
});

suite.test('HEAD / - Service health check (200)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'HEAD',
    path: '/',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 200, 'Status code');
});

suite.test('POST / - Method not allowed (405)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'POST',
    path: '/',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 405, 'Status code');
});

// ============================================
// Bucket API Tests
// ============================================

suite.test('PUT /{bucket} - Create bucket (200)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'PUT',
    path: '/test-bucket',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 200, 'Status code');
});

suite.test('PUT /{bucket} - Create duplicate bucket (409)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'PUT',
    path: '/test-bucket',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 409, 'Status code');
  suite.assertTrue(res.data.includes('BucketAlreadyExists'), 'Error code');
});

suite.test('PUT /{bucket} - Create bucket without auth (401)', async () => {
  const res = await makeRequest({
    method: 'PUT',
    path: '/another-bucket'
  });

  suite.assertEqual(res.status, 401, 'Status code');
});

suite.test('HEAD /{bucket} - Check bucket exists (200)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'HEAD',
    path: '/test-bucket',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 200, 'Status code');
});

suite.test('HEAD /{bucket} - Check non-existent bucket (404)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'HEAD',
    path: '/non-existent-bucket',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 404, 'Status code');
});

suite.test('GET /{bucket} - List objects (200)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'GET',
    path: '/test-bucket',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 200, 'Status code');
  suite.assertTrue(res.data.includes('ListBucketResult'), 'Response has ListBucketResult');
});

suite.test('GET /{bucket} - List objects in non-existent bucket (404)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'GET',
    path: '/non-existent-bucket',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 404, 'Status code');
  suite.assertTrue(res.data.includes('NoSuchBucket'), 'Error code');
});

suite.test('GET /{bucket}?uploads - List multipart uploads (200)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'GET',
    path: '/test-bucket?uploads',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 200, 'Status code');
  suite.assertEqual(res.json().message, 'Multipart upload list (mock)', 'Response message');
});

suite.test('DELETE /{bucket} - Delete non-existent bucket (404)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'DELETE',
    path: '/non-existent-bucket',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 404, 'Status code');
  suite.assertTrue(res.data.includes('NoSuchBucket'), 'Error code');
});

suite.test('DELETE /{bucket} - Delete non-empty bucket (409)', async () => {
  const token = suite.tokens[0];

  // Upload an object first
  await makeRequest({
    method: 'PUT',
    path: '/test-bucket/test-object.txt',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/plain'
    }
  }, Buffer.from('test content'));

  // Try to delete the bucket
  const res = await makeRequest({
    method: 'DELETE',
    path: '/test-bucket',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 409, 'Status code');
  suite.assertTrue(res.data.includes('BucketNotEmpty'), 'Error code');
});

suite.test('POST /{bucket} - Method not allowed (405)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'POST',
    path: '/test-bucket',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 405, 'Status code');
});

// ============================================
// Object API Tests
// ============================================

suite.test('PUT /{bucket}/{key} - Upload object (200)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'PUT',
    path: '/test-bucket/new-object.txt',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/plain'
    }
  }, Buffer.from('Hello, World!'));

  suite.assertEqual(res.status, 200, 'Status code');
  suite.assertTrue(res.headers['etag'], 'Response has ETag');
});

suite.test('PUT /{bucket}/{key} - Upload to non-existent bucket (404)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'PUT',
    path: '/non-existent-bucket/object.txt',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/plain'
    }
  }, Buffer.from('content'));

  suite.assertEqual(res.status, 404, 'Status code');
  suite.assertTrue(res.data.includes('NoSuchBucket'), 'Error code');
});

suite.test('PUT /{bucket}/{key} - Upload without auth (401)', async () => {
  const res = await makeRequest({
    method: 'PUT',
    path: '/test-bucket/object.txt',
    headers: {
      'Content-Type': 'text/plain'
    }
  }, Buffer.from('content'));

  suite.assertEqual(res.status, 401, 'Status code');
});

suite.test('GET /{bucket}/{key} - Download object (200)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'GET',
    path: '/test-bucket/new-object.txt',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 200, 'Status code');
  suite.assertEqual(res.data, 'Hello, World!', 'Response body');
  suite.assertEqual(res.headers['content-type'], 'text/plain', 'Content-Type');
  suite.assertTrue(res.headers['etag'], 'Response has ETag');
});

suite.test('GET /{bucket}/{key} - Download non-existent object (404)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'GET',
    path: '/test-bucket/non-existent-object.txt',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 404, 'Status code');
  suite.assertTrue(res.data.includes('NoSuchKey'), 'Error code');
});

suite.test('HEAD /{bucket}/{key} - Get object metadata (200)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'HEAD',
    path: '/test-bucket/new-object.txt',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 200, 'Status code');
  suite.assertEqual(res.headers['content-type'], 'text/plain', 'Content-Type');
  suite.assertEqual(res.headers['content-length'], '13', 'Content-Length');
  suite.assertTrue(res.headers['etag'], 'Response has ETag');
  suite.assertTrue(res.headers['last-modified'], 'Response has Last-Modified');
});

suite.test('HEAD /{bucket}/{key} - Get metadata for non-existent object (404)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'HEAD',
    path: '/test-bucket/non-existent-object.txt',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 404, 'Status code');
});

suite.test('DELETE /{bucket}/{key} - Delete object (204)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'DELETE',
    path: '/test-bucket/new-object.txt',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 204, 'Status code');
});

suite.test('DELETE /{bucket}/{key} - Delete non-existent object (204)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'DELETE',
    path: '/test-bucket/non-existent-object.txt',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 204, 'Status code');
});

suite.test('POST /{bucket}/{key} - Method not allowed (405)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'POST',
    path: '/test-bucket/object.txt',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 405, 'Status code');
});

// ============================================
// Copy Object Tests
// ============================================

suite.test('PUT /{bucket}/{key}?copySource - Copy object (200)', async () => {
  const token = suite.tokens[0];

  // Create source object
  await makeRequest({
    method: 'PUT',
    path: '/test-bucket/source-object.txt',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/plain'
    }
  }, Buffer.from('Source content'));

  // Copy object
  const res = await makeRequest({
    method: 'PUT',
    path: '/test-bucket/copied-object.txt?copySource=%2Ftest-bucket%2Fsource-object.txt',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 200, 'Status code');
  suite.assertTrue(res.data.includes('CopyObjectResult'), 'Response has CopyObjectResult');

  // Verify the copy exists
  const getRes = await makeRequest({
    method: 'GET',
    path: '/test-bucket/copied-object.txt',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(getRes.status, 200, 'Copy exists');
  suite.assertEqual(getRes.data, 'Source content', 'Copy has correct content');
});

suite.test('PUT /{bucket}/{key}?copySource - Copy non-existent source (404)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'PUT',
    path: '/test-bucket/dest-object.txt?copySource=%2Ftest-bucket%2Fnon-existent-source.txt',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  suite.assertEqual(res.status, 404, 'Status code');
});

// ============================================
// List Objects with Query Parameters Tests
// ============================================

suite.test('GET /{bucket}?prefix - List objects with prefix (200)', async () => {
  const token = suite.tokens[0];

  // Create objects with different prefixes
  await makeRequest({
    method: 'PUT',
    path: '/test-bucket/folder1/file1.txt',
    headers: { 'Authorization': `Bearer ${token}` }
  }, Buffer.from('content1'));

  await makeRequest({
    method: 'PUT',
    path: '/test-bucket/folder2/file2.txt',
    headers: { 'Authorization': `Bearer ${token}` }
  }, Buffer.from('content2'));

  const res = await makeRequest({
    method: 'GET',
    path: '/test-bucket?prefix=folder1%2F',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  suite.assertEqual(res.status, 200, 'Status code');
  suite.assertTrue(res.data.includes('folder1/file1.txt'), 'Response includes folder1/file1.txt');
  suite.assertFalse(res.data.includes('folder2/file2.txt'), 'Response does not include folder2/file2.txt');
});

suite.test('GET /{bucket}?max-keys - List objects with max-keys (200)', async () => {
  const token = suite.tokens[0];

  const res = await makeRequest({
    method: 'GET',
    path: '/test-bucket?max-keys=2',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  suite.assertEqual(res.status, 200, 'Status code');
  suite.assertTrue(res.data.includes('MaxKeys'), 'Response includes MaxKeys');
});

// ============================================
// Multi-tenant Isolation Tests
// ============================================

suite.test('Multi-tenant isolation - Bucket not visible to other tenant', async () => {
  // Generate two tokens
  const genRes1 = await makeRequest({ method: 'POST', path: '/__internal__/auth/token' });
  const token1 = genRes1.json().token;

  const genRes2 = await makeRequest({ method: 'POST', path: '/__internal__/auth/token' });
  const token2 = genRes2.json().token;

  // Create bucket with token1
  await makeRequest({
    method: 'PUT',
    path: '/tenant1-bucket',
    headers: { 'Authorization': `Bearer ${token1}` }
  });

  // List buckets with token2 - should not see tenant1-bucket
  const res = await makeRequest({
    method: 'GET',
    path: '/',
    headers: { 'Authorization': `Bearer ${token2}` }
  });

  suite.assertEqual(res.status, 200, 'Status code');
  suite.assertFalse(res.data.includes('tenant1-bucket'), 'Bucket not visible to other tenant');

  // List buckets with token1 - should see tenant1-bucket
  const res1 = await makeRequest({
    method: 'GET',
    path: '/',
    headers: { 'Authorization': `Bearer ${token1}` }
  });

  suite.assertTrue(res1.data.includes('tenant1-bucket'), 'Bucket visible to owner');
});

// ============================================
// Cleanup Tests
// ============================================

suite.test('DELETE /{bucket} - Delete empty bucket (204)', async () => {
  const token = suite.tokens[0];

  // First, delete all objects in the bucket
  const listRes = await makeRequest({
    method: 'GET',
    path: '/test-bucket',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  // Parse XML to get object keys
  const keys = listRes.data.match(/<Key>([^<]+)<\/Key>/g) || [];
  for (const keyMatch of keys) {
    const key = keyMatch.replace(/<\/?Key>/g, '');
    await makeRequest({
      method: 'DELETE',
      path: `/test-bucket/${key}`,
      headers: { 'Authorization': `Bearer ${token}` }
    });
  }

  // Now delete the bucket
  const res = await makeRequest({
    method: 'DELETE',
    path: '/test-bucket',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  suite.assertEqual(res.status, 204, 'Status code');
});

// ============================================
// Run all tests
// ============================================

async function main() {
  await suite.setup();
  await suite.run();
  await suite.teardown();

  process.exit(suite.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
