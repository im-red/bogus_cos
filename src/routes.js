const storage = require('./storage');

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve(buffer);
    });
    req.on('error', reject);
  });
}

function parseXmlBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const result = {};
      const keyMatch = body.match(/<(\w+)>([^<]*)<\/\1>/g);
      if (keyMatch) {
        keyMatch.forEach(match => {
          const [, key, value] = match.match(/<(\w+)>([^<]*)<\/\1>/);
          result[key] = value;
        });
      }
      resolve(result);
    });
    req.on('error', reject);
  });
}

function sendXml(res, statusCode, xml) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/xml');
  res.end(xml);
}

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function buildXmlResponse(rootName, data) {
  const buildXml = (obj, indent = '') => {
    let xml = '';
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        value.forEach(item => {
          xml += `${indent}<${key}>${buildXml(item, indent + '  ')}${indent}</${key}>\n`;
        });
      } else if (typeof value === 'object') {
        xml += `${indent}<${key}>${buildXml(value, indent + '  ')}${indent}</${key}>\n`;
      } else {
        xml += `${indent}<${key}>${escapeXml(String(value))}</${key}>\n`;
      }
    }
    return xml;
  };

  return `<?xml version="1.0" encoding="UTF-8"?>\n<${rootName}>${buildXml(data)}</${rootName}>`;
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getTenantId(req) {
  return req.tokenInfo?.tenantId || 'default';
}

async function handleBucketOperations(req, res, bucketName) {
  const method = req.method;
  const query = req.query;
  const tenantId = getTenantId(req);

  if (method === 'PUT') {
    const result = storage.createBucket(tenantId, bucketName);
    if (result.success) {
      res.statusCode = 200;
      res.end();
    } else {
      sendXml(res, 409, buildXmlResponse('Error', {
        Code: result.error,
        Message: 'The requested bucket name is not available.',
        Resource: bucketName
      }));
    }
    return;
  }

  if (method === 'DELETE') {
    const result = storage.deleteBucket(tenantId, bucketName);
    if (result.success) {
      res.statusCode = 204;
      res.end();
    } else {
      const statusCode = result.error === 'NoSuchBucket' ? 404 : 409;
      sendXml(res, statusCode, buildXmlResponse('Error', {
        Code: result.error,
        Message: result.error === 'NoSuchBucket' ? 'The specified bucket does not exist.' : 'The bucket you tried to delete is not empty.',
        Resource: bucketName
      }));
    }
    return;
  }

  if (method === 'GET') {
    if (query.uploads !== undefined) {
      sendJson(res, 200, { message: 'Multipart upload list (mock)', uploads: [] });
      return;
    }

    const result = storage.listObjects(tenantId, bucketName, {
      prefix: query.prefix || '',
      delimiter: query.delimiter,
      maxKeys: parseInt(query['max-keys']) || 1000,
      marker: query.marker || ''
    });

    if (!result.success) {
      sendXml(res, 404, buildXmlResponse('Error', {
        Code: result.error,
        Message: 'The specified bucket does not exist.',
        Resource: bucketName
      }));
      return;
    }

    const xmlResponse = buildXmlResponse('ListBucketResult', {
      Name: result.name,
      Prefix: result.prefix,
      Delimiter: result.delimiter,
      MaxKeys: result.maxKeys,
      IsTruncated: result.isTruncated,
      NextMarker: result.nextMarker,
      Contents: result.contents.map(obj => ({
        Key: obj.key,
        LastModified: obj.lastModified,
        ETag: `"${obj.etag}"`,
        Size: obj.size,
        StorageClass: obj.storageClass
      })),
      CommonPrefixes: result.commonPrefixes.map(p => ({ Prefix: p }))
    });

    sendXml(res, 200, xmlResponse);
    return;
  }

  if (method === 'HEAD') {
    const tenant = storage.tenants.get(tenantId);
    if (tenant && tenant.buckets.has(bucketName)) {
      res.statusCode = 200;
      res.end();
    } else {
      res.statusCode = 404;
      res.end();
    }
    return;
  }

  res.statusCode = 405;
  res.end();
}

async function handleObjectOperations(req, res, bucketName, objectKey) {
  const method = req.method;
  const query = req.query;
  const tenantId = getTenantId(req);

  if (method === 'PUT') {
    if (query.copySource) {
      const copySource = decodeURIComponent(query.copySource);
      const [srcBucket, ...srcKeyParts] = copySource.split('/').filter(Boolean);
      const srcKey = srcKeyParts.join('/');

      const result = storage.copyObject(tenantId, srcBucket, srcKey, bucketName, objectKey);
      if (result.success) {
        sendXml(res, 200, buildXmlResponse('CopyObjectResult', {
          LastModified: new Date().toISOString(),
          ETag: `"${result.etag}"`
        }));
      } else {
        sendXml(res, 404, buildXmlResponse('Error', {
          Code: result.error,
          Message: 'The source object does not exist.'
        }));
      }
      return;
    }

    const data = await parseBody(req);
    const metadata = {
      'content-type': req.headers['content-type'],
      'content-encoding': req.headers['content-encoding'],
      ...extractCustomMetadata(req.headers)
    };

    const result = storage.putObject(tenantId, bucketName, objectKey, data, metadata);
    if (result.success) {
      res.statusCode = 200;
      res.setHeader('ETag', `"${result.etag}"`);
      res.end();
    } else {
      sendXml(res, 404, buildXmlResponse('Error', {
        Code: result.error,
        Message: 'The specified bucket does not exist.'
      }));
    }
    return;
  }

  if (method === 'GET') {
    const result = storage.getObject(tenantId, bucketName, objectKey);
    if (!result.success) {
      sendXml(res, 404, buildXmlResponse('Error', {
        Code: result.error,
        Message: 'The specified key does not exist.'
      }));
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', result.object.contentType);
    res.setHeader('Content-Length', result.object.size);
    res.setHeader('ETag', `"${result.object.etag}"`);
    res.setHeader('Last-Modified', result.object.lastModified);

    Object.entries(result.object.metadata).forEach(([key, value]) => {
      if (key.startsWith('x-cos-meta-')) {
        res.setHeader(key, value);
      }
    });

    res.end(result.object.data);
    return;
  }

  if (method === 'DELETE') {
    const result = storage.deleteObject(tenantId, bucketName, objectKey);
    if (result.success) {
      res.statusCode = 204;
      res.end();
    } else {
      res.statusCode = 204;
      res.end();
    }
    return;
  }

  if (method === 'HEAD') {
    const result = storage.headObject(tenantId, bucketName, objectKey);
    if (!result.success) {
      res.statusCode = 404;
      res.end();
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', result.metadata.contentType);
    res.setHeader('Content-Length', result.metadata.contentLength);
    res.setHeader('ETag', `"${result.metadata.etag}"`);
    res.setHeader('Last-Modified', result.metadata.lastModified);
    res.end();
    return;
  }

  res.statusCode = 405;
  res.end();
}

function extractCustomMetadata(headers) {
  const metadata = {};
  Object.keys(headers).forEach(key => {
    if (key.toLowerCase().startsWith('x-cos-meta-')) {
      metadata[key.toLowerCase()] = headers[key];
    }
  });
  return metadata;
}

async function handleServiceRequest(req, res) {
  if (req.method === 'GET') {
    const tenantId = getTenantId(req);
    const buckets = storage.listBuckets(tenantId);
    const xmlResponse = buildXmlResponse('ListAllMyBucketsResult', {
      Owner: {
        ID: 'bogus-cos-owner',
        DisplayName: 'Bogus COS Owner'
      },
      Buckets: {
        Bucket: buckets.map(b => ({
          Name: b.name,
          CreationDate: b.creationDate
        }))
      }
    });
    sendXml(res, 200, xmlResponse);
    return;
  }

  if (req.method === 'HEAD') {
    res.statusCode = 200;
    res.end();
    return;
  }

  res.statusCode = 405;
  res.end();
}

module.exports = {
  handleBucketOperations,
  handleObjectOperations,
  handleServiceRequest,
  parseBody,
  getTenantId
};
