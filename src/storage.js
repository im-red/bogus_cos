const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class StorageService {
  constructor(dataDir = process.env.COS_DATA_DIR || './data') {
    this.dataDir = path.resolve(dataDir);
    this.tenants = new Map();
    this.autoSave = process.env.COS_AUTO_SAVE !== 'false';
    this.saveTimeouts = new Map();
    this.saveDebounceMs = parseInt(process.env.COS_SAVE_DEBOUNCE) || 1000;

    this.loadAllTenants();
  }

  getTenantDir(tenantId) {
    return path.join(this.dataDir, tenantId);
  }

  getTenantMetadataFile(tenantId) {
    return path.join(this.getTenantDir(tenantId), 'metadata.json');
  }

  getTenantObjectsDir(tenantId) {
    return path.join(this.getTenantDir(tenantId), 'objects');
  }

  ensureTenant(tenantId) {
    if (!this.tenants.has(tenantId)) {
      this.tenants.set(tenantId, {
        buckets: new Map(),
        objects: new Map()
      });
    }
    return this.tenants.get(tenantId);
  }

  loadAllTenants() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
        return;
      }

      const entries = fs.readdirSync(this.dataDir, { withFileTypes: true });
      let totalBuckets = 0;
      let totalObjects = 0;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const tenantId = entry.name;
        const metadataFile = this.getTenantMetadataFile(tenantId);

        if (fs.existsSync(metadataFile)) {
          const data = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'));
          const tenant = this.ensureTenant(tenantId);

          if (data.buckets) {
            data.buckets.forEach(bucket => {
              tenant.buckets.set(bucket.name, bucket);
            });
          }

          if (data.objects) {
            data.objects.forEach(objMeta => {
              tenant.objects.set(`${objMeta.bucket}/${objMeta.key}`, {
                ...objMeta,
                data: null
              });
            });
          }

          totalBuckets += tenant.buckets.size;
          totalObjects += tenant.objects.size;
        }
      }

      console.log(`Loaded ${this.tenants.size} tenants, ${totalBuckets} buckets, ${totalObjects} objects from disk`);
    } catch (err) {
      console.error('Error loading data from disk:', err.message);
    }
  }

  saveTenantToDisk(tenantId) {
    try {
      const tenantDir = this.getTenantDir(tenantId);
      const objectsDir = this.getTenantObjectsDir(tenantId);

      if (!fs.existsSync(tenantDir)) {
        fs.mkdirSync(tenantDir, { recursive: true });
      }

      if (!fs.existsSync(objectsDir)) {
        fs.mkdirSync(objectsDir, { recursive: true });
      }

      const tenant = this.tenants.get(tenantId);
      if (!tenant) return;

      const buckets = Array.from(tenant.buckets.values());
      const objects = Array.from(tenant.objects.values()).map(obj => ({
        key: obj.key,
        bucket: obj.bucket,
        lastModified: obj.lastModified,
        etag: obj.etag,
        size: obj.size,
        contentType: obj.contentType,
        metadata: obj.metadata
      }));

      const metadataFile = this.getTenantMetadataFile(tenantId);
      fs.writeFileSync(metadataFile, JSON.stringify({ buckets, objects }, null, 2));
    } catch (err) {
      console.error(`Error saving tenant ${tenantId} to disk:`, err.message);
    }
  }

  scheduleSave(tenantId) {
    if (!this.autoSave) return;

    if (this.saveTimeouts.has(tenantId)) {
      clearTimeout(this.saveTimeouts.get(tenantId));
    }

    this.saveTimeouts.set(tenantId, setTimeout(() => {
      this.saveTenantToDisk(tenantId);
      this.saveTimeouts.delete(tenantId);
    }, this.saveDebounceMs));
  }

  getObjectPath(tenantId, bucketName, key) {
    const safeKey = key.replace(/\//g, path.sep);
    return path.join(this.getTenantObjectsDir(tenantId), bucketName, safeKey);
  }

  createBucket(tenantId, bucketName) {
    const tenant = this.ensureTenant(tenantId);

    if (tenant.buckets.has(bucketName)) {
      return { success: false, error: 'BucketAlreadyExists' };
    }

    tenant.buckets.set(bucketName, {
      name: bucketName,
      creationDate: new Date().toISOString()
    });

    this.scheduleSave(tenantId);
    return { success: true, bucket: tenant.buckets.get(bucketName) };
  }

  deleteBucket(tenantId, bucketName) {
    const tenant = this.tenants.get(tenantId);

    if (!tenant || !tenant.buckets.has(bucketName)) {
      return { success: false, error: 'NoSuchBucket' };
    }

    const bucketObjects = this.listObjects(tenantId, bucketName);
    if (bucketObjects.contents.length > 0) {
      return { success: false, error: 'BucketNotEmpty' };
    }

    const bucketDir = path.join(this.getTenantObjectsDir(tenantId), bucketName);
    if (fs.existsSync(bucketDir)) {
      fs.rmSync(bucketDir, { recursive: true });
    }

    tenant.buckets.delete(bucketName);
    this.scheduleSave(tenantId);
    return { success: true };
  }

  listBuckets(tenantId) {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return [];
    }
    return Array.from(tenant.buckets.values());
  }

  putObject(tenantId, bucketName, key, data, metadata = {}) {
    const tenant = this.ensureTenant(tenantId);

    if (!tenant.buckets.has(bucketName)) {
      return { success: false, error: 'NoSuchBucket' };
    }

    const objectKey = `${bucketName}/${key}`;
    const objectInfo = {
      key,
      bucket: bucketName,
      lastModified: new Date().toISOString(),
      etag: uuidv4(),
      size: Buffer.byteLength(data),
      contentType: metadata['content-type'] || 'application/octet-stream',
      metadata: metadata,
      data: data
    };

    const objectPath = this.getObjectPath(tenantId, bucketName, key);
    const objectDir = path.dirname(objectPath);

    try {
      if (!fs.existsSync(objectDir)) {
        fs.mkdirSync(objectDir, { recursive: true });
      }
      fs.writeFileSync(objectPath, data);

      tenant.objects.set(objectKey, { ...objectInfo, data: null });
      this.scheduleSave(tenantId);

      return { success: true, etag: objectInfo.etag };
    } catch (err) {
      console.error('Error writing object to disk:', err.message);
      return { success: false, error: 'InternalError' };
    }
  }

  getObject(tenantId, bucketName, key) {
    const tenant = this.tenants.get(tenantId);

    if (!tenant) {
      return { success: false, error: 'NoSuchKey' };
    }

    const objectKey = `${bucketName}/${key}`;
    const objectMeta = tenant.objects.get(objectKey);

    if (!objectMeta) {
      return { success: false, error: 'NoSuchKey' };
    }

    const objectPath = this.getObjectPath(tenantId, bucketName, key);

    try {
      if (fs.existsSync(objectPath)) {
        const data = fs.readFileSync(objectPath);
        return {
          success: true,
          object: {
            ...objectMeta,
            data
          }
        };
      } else {
        return { success: false, error: 'NoSuchKey' };
      }
    } catch (err) {
      console.error('Error reading object from disk:', err.message);
      return { success: false, error: 'InternalError' };
    }
  }

  deleteObject(tenantId, bucketName, key) {
    const tenant = this.tenants.get(tenantId);

    if (!tenant) {
      return { success: false, error: 'NoSuchKey' };
    }

    const objectKey = `${bucketName}/${key}`;
    if (!tenant.objects.has(objectKey)) {
      return { success: false, error: 'NoSuchKey' };
    }

    const objectPath = this.getObjectPath(tenantId, bucketName, key);

    try {
      if (fs.existsSync(objectPath)) {
        fs.unlinkSync(objectPath);
      }

      this.removeEmptyDirs(path.dirname(objectPath), this.getTenantObjectsDir(tenantId));
    } catch (err) {
      console.error('Error deleting object from disk:', err.message);
    }

    tenant.objects.delete(objectKey);
    this.scheduleSave(tenantId);
    return { success: true };
  }

  removeEmptyDirs(dirPath, stopDir) {
    if (!dirPath || dirPath === stopDir || !dirPath.startsWith(stopDir)) {
      return;
    }

    try {
      const entries = fs.readdirSync(dirPath);
      if (entries.length === 0) {
        fs.rmdirSync(dirPath);
        this.removeEmptyDirs(path.dirname(dirPath), stopDir);
      }
    } catch (err) {
      // Ignore errors - directory may not exist or not be empty
    }
  }

  listObjects(tenantId, bucketName, options = {}) {
    const tenant = this.tenants.get(tenantId);

    if (!tenant || !tenant.buckets.has(bucketName)) {
      return { success: false, error: 'NoSuchBucket', contents: [], commonPrefixes: [] };
    }

    const prefix = options.prefix || '';
    const delimiter = options.delimiter;
    const maxKeys = options.maxKeys || 1000;
    const marker = options.marker || '';

    let objects = [];
    let commonPrefixes = new Set();
    let isTruncated = false;
    let nextMarker = null;

    for (const [key, object] of tenant.objects) {
      if (!key.startsWith(`${bucketName}/`)) continue;

      const objectKey = key.slice(bucketName.length + 1);

      if (prefix && !objectKey.startsWith(prefix)) continue;
      if (marker && objectKey <= marker) continue;

      if (delimiter) {
        const delimiterIndex = objectKey.indexOf(delimiter, prefix.length);
        if (delimiterIndex !== -1) {
          const commonPrefix = objectKey.substring(0, delimiterIndex + 1);
          commonPrefixes.add(commonPrefix);
          continue;
        }
      }

      objects.push({
        key: objectKey,
        lastModified: object.lastModified,
        etag: object.etag,
        size: object.size,
        storageClass: 'STANDARD'
      });
    }

    objects.sort((a, b) => a.key.localeCompare(b.key));

    if (objects.length > maxKeys) {
      isTruncated = true;
      objects = objects.slice(0, maxKeys);
      nextMarker = objects[objects.length - 1].key;
    }

    return {
      success: true,
      name: bucketName,
      prefix,
      delimiter,
      maxKeys,
      isTruncated,
      nextMarker,
      contents: objects,
      commonPrefixes: Array.from(commonPrefixes)
    };
  }

  headObject(tenantId, bucketName, key) {
    const tenant = this.tenants.get(tenantId);

    if (!tenant) {
      return { success: false, error: 'NoSuchKey' };
    }

    const objectKey = `${bucketName}/${key}`;
    const object = tenant.objects.get(objectKey);

    if (!object) {
      return { success: false, error: 'NoSuchKey' };
    }

    return {
      success: true,
      metadata: {
        contentLength: object.size,
        contentType: object.contentType,
        lastModified: object.lastModified,
        etag: object.etag,
        metadata: object.metadata
      }
    };
  }

  copyObject(tenantId, sourceBucket, sourceKey, destBucket, destKey) {
    const sourceResult = this.getObject(tenantId, sourceBucket, sourceKey);
    if (!sourceResult.success) {
      return sourceResult;
    }

    return this.putObject(tenantId, destBucket, destKey, sourceResult.object.data, sourceResult.object.metadata);
  }

  flush(tenantId = null) {
    if (tenantId) {
      if (this.saveTimeouts.has(tenantId)) {
        clearTimeout(this.saveTimeouts.get(tenantId));
        this.saveTimeouts.delete(tenantId);
      }
      this.saveTenantToDisk(tenantId);
    } else {
      for (const [tid, timeout] of this.saveTimeouts) {
        clearTimeout(timeout);
      }
      this.saveTimeouts.clear();
      for (const tid of this.tenants.keys()) {
        this.saveTenantToDisk(tid);
      }
    }
  }

  getStats(allTenantIds = []) {
    // Combine tenants from storage with all tenant IDs from tokens
    const allTenants = new Set([...this.tenants.keys(), ...allTenantIds]);

    const stats = {
      tenants: allTenants.size,
      totalBuckets: 0,
      totalObjects: 0,
      tenantsDetail: []
    };

    for (const tenantId of allTenants) {
      const tenant = this.tenants.get(tenantId);
      const buckets = tenant ? tenant.buckets.size : 0;
      const objects = tenant ? tenant.objects.size : 0;
      stats.totalBuckets += buckets;
      stats.totalObjects += objects;
      stats.tenantsDetail.push({
        tenantId,
        buckets,
        objects
      });
    }

    return stats;
  }
}

const storage = new StorageService();

module.exports = storage;
