# Bogus COS

A lightweight mock COS (Cloud Object Storage) service for local development and testing. Built with Node.js, designed to be serverless-friendly and easy to use.

## Features

- **Full COS API Compatibility** - Supports typical COS operations
- **UUID Authentication** - Simple token-based authentication
- **Disk Persistence** - Data survives server restarts
- **Serverless Ready** - Exportable handler for AWS Lambda / Tencent Cloud SCF
- **Zero Configuration** - Works out of the box with sensible defaults
- **Lightweight** - Minimal dependencies, fast startup

## Installation

```bash
# Clone or download the project
cd bogus_cos

# Install dependencies
npm install

# Start the server
npm start
```

## Quick Start

```bash
# Start the server
npm start

# The server will output:
# Bogus COS Mock Server started at http://0.0.0.0:9000
# Authentication: Enabled
# Data directory: /path/to/bogus_cos/data
```

### Get an Authentication Token

```bash
curl -X POST http://localhost:9000/__auth/token
# Response: {"token":"your-uuid-token"}
```

### Create a Bucket

```bash
curl -X PUT http://localhost:9000/my-bucket \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Upload an Object

```bash
curl -X PUT http://localhost:9000/my-bucket/hello.txt \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: text/plain" \
  -d "Hello, World!"
```

### Download an Object

```bash
curl http://localhost:9000/my-bucket/hello.txt \
  -H "Authorization: Bearer YOUR_TOKEN"
# Response: Hello, World!
```

### List Objects in a Bucket

```bash
curl http://localhost:9000/my-bucket \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Delete an Object

```bash
curl -X DELETE http://localhost:9000/my-bucket/hello.txt \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## API Reference

### Authentication Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/__auth/token` | Generate a new authentication token |

### Service Operations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List all buckets |

### Bucket Operations

| Method | Path | Description |
|--------|------|-------------|
| PUT | `/<bucket>` | Create a bucket |
| DELETE | `/<bucket>` | Delete an empty bucket |
| HEAD | `/<bucket>` | Check if bucket exists |
| GET | `/<bucket>` | List objects in bucket |

### Object Operations

| Method | Path | Description |
|--------|------|-------------|
| PUT | `/<bucket>/<key>` | Upload an object |
| GET | `/<bucket>/<key>` | Download an object |
| DELETE | `/<bucket>/<key>` | Delete an object |
| HEAD | `/<bucket>/<key>` | Get object metadata |
| PUT | `/<bucket>/<key>?copySource=/src-bucket/src-key` | Copy an object |

### Query Parameters for List Objects

| Parameter | Description |
|-----------|-------------|
| `prefix` | Only return objects starting with this prefix |
| `delimiter` | Group objects by this delimiter (e.g., `/`) |
| `max-keys` | Maximum number of keys to return (default: 1000) |
| `marker` | Start listing after this key (for pagination) |

## Authentication

Bogus COS uses UUID-based token authentication. Tokens can be provided in three ways:

1. **Authorization Header** (Recommended)
   ```
   Authorization: Bearer YOUR_TOKEN
   ```

2. **Custom Header**
   ```
   X-COS-Token: YOUR_TOKEN
   ```

3. **Query Parameter**
   ```
   http://localhost:9000/bucket/key?token=YOUR_TOKEN
   ```

### Pre-defined Token

You can set a fixed token via environment variable:

```bash
COS_TOKEN=my-secret-token npm start
```

Then use this token for all requests.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `COS_PORT` | Server port | `9000` |
| `COS_HOST` | Server host | `0.0.0.0` |
| `COS_ENABLE_AUTH` | Enable authentication (`true`/`false`) | `true` |
| `COS_TOKEN` | Pre-defined authentication token | (none) |
| `COS_DATA_DIR` | Directory for persistent storage | `./data` |
| `COS_AUTO_SAVE` | Enable auto-save to disk (`true`/`false`) | `true` |
| `COS_SAVE_DEBOUNCE` | Debounce delay for auto-save (ms) | `1000` |

### Examples

```bash
# Disable authentication (for development)
COS_ENABLE_AUTH=false npm start

# Use custom port and data directory
COS_PORT=3000 COS_DATA_DIR=/var/lib/cos-data npm start

# Use a fixed token
COS_TOKEN=dev-token-12345 npm start
```

## Data Persistence

Data is automatically persisted to disk:

```
data/
├── metadata.json      # Buckets and object metadata
└── objects/
    └── <bucket>/
        └── <key>      # Object data files
```

- **metadata.json** - Stores bucket information and object metadata (name, size, content-type, etc.)
- **objects/** - Stores the actual file contents in a directory structure matching bucket/key

Data is loaded automatically on startup and saved after each modification (with debouncing).

## Serverless Usage

Bogus COS can be used as a serverless handler:

```javascript
const { createServerlessHandler } = require('bogus_cos');

const handler = createServerlessHandler();

// Use with AWS Lambda / API Gateway
exports.handler = async (event, context) => {
  return await handler(event, context);
};

// Or with Tencent Cloud SCF
exports.main_handler = async (event, context) => {
  return await handler(event, context);
};
```

### Event Format

The handler expects an event object with:

```javascript
{
  httpMethod: 'GET',           // HTTP method
  path: '/bucket/key',         // Request path
  headers: {                   // Request headers
    'authorization': 'Bearer token',
    'content-type': 'application/json'
  },
  body: 'request body',        // Request body (string)
  isBase64Encoded: false       // Whether body is base64 encoded
}
```

### Response Format

The handler returns:

```javascript
{
  statusCode: 200,
  headers: {
    'content-type': 'application/json'
  },
  body: 'response body',
  isBase64Encoded: false
}
```

## Programmatic Usage

```javascript
const { 
  createServer, 
  startServer, 
  storage, 
  auth 
} = require('bogus_cos');

// Generate a token
const token = auth.generateToken();
console.log('Token:', token);

// Create and start server
const server = await startServer(9000, 'localhost');

// Or create server without starting
const server = createServer();
server.listen(9000, () => {
  console.log('Server started');
});

// Access storage directly
storage.createBucket('my-bucket');
storage.putObject('my-bucket', 'file.txt', Buffer.from('content'));
const result = storage.getObject('my-bucket', 'file.txt');
console.log(result.object.data.toString());

// Flush data to disk
storage.flush();
```

## API Response Formats

### XML Responses (COS Compatible)

List Buckets:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult>
  <Owner>
    <ID>bogus-cos-owner</ID>
    <DisplayName>Bogus COS Owner</DisplayName>
  </Owner>
  <Buckets>
    <Bucket>
      <Name>my-bucket</Name>
      <CreationDate>2024-01-01T00:00:00.000Z</CreationDate>
    </Bucket>
  </Buckets>
</ListAllMyBucketsResult>
```

List Objects:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>my-bucket</Name>
  <Prefix></Prefix>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>file.txt</Key>
    <LastModified>2024-01-01T00:00:00.000Z</LastModified>
    <ETag>"uuid-etag"</ETag>
    <Size>7</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
</ListBucketResult>
```

Error Response:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchKey</Code>
  <Message>The specified key does not exist.</Message>
</Error>
```

### JSON Responses (Authentication)

```json
{
  "token": "550e8400-e29b-41d4-a716-446655440000"
}
```

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `InvalidToken` | 401 | Invalid or missing authentication token |
| `BucketAlreadyExists` | 409 | Bucket name already taken |
| `NoSuchBucket` | 404 | Bucket does not exist |
| `BucketNotEmpty` | 409 | Cannot delete non-empty bucket |
| `NoSuchKey` | 404 | Object does not exist |
| `InternalError` | 500 | Internal server error |

## Development

```bash
# Start with auto-reload on file changes
npm run dev

# Run tests
node test.js
```

## Use Cases

- **Local Development** - Test applications that use COS without connecting to real cloud storage
- **CI/CD Pipelines** - Fast, isolated storage for automated tests
- **Prototyping** - Quickly prototype applications without cloud setup
- **Offline Development** - Work without internet connection
- **Serverless Functions** - Deploy as a mock service in serverless environments

## License

MIT
