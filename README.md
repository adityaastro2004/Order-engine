# Order Execution Engine

A high-performance order execution engine built with Node.js, TypeScript, and Fastify that routes cryptocurrency swap orders to the best DEX (Decentralized Exchange) with real-time WebSocket status updates.

## 🚀 Features

- **Smart DEX Routing**: Automatically compares prices between Raydium and Meteora to find the best execution price
- **Real-time Updates**: WebSocket connections provide live order status updates through all execution stages
- **Job Queue Processing**: BullMQ-powered queue system with Redis for reliable order processing
- **PostgreSQL Persistence**: All orders stored in database for historical tracking and late-connection handling
- **TypeScript ES Modules**: Modern ES module architecture with full TypeScript support
- **Auto-reload Development**: Nodemon integration for seamless development experience

## 📋 Order Lifecycle

Orders progress through the following stages:

1. **pending** - Order received and queued for processing
2. **routing** - Comparing prices across multiple DEXs (Raydium vs Meteora)
3. **building** - Creating transaction for the best DEX
4. **submitted** - Transaction sent to network, awaiting confirmation
5. **confirmed** - Transaction successfully executed (final state)
6. **failed** - Transaction or processing error occurred (final state)

## 🏗️ Architecture

### Components

- **Server (`src/server.ts`)**: Fastify web server with REST API and WebSocket endpoints
- **Worker (`src/worker.ts`)**: BullMQ worker that processes orders and publishes status updates
- **Database (`src/db.ts`)**: PostgreSQL connection pool and order persistence layer
- **DEX Router (`src/services/DEXrouter.ts`)**: Mock DEX integration for price quotes and execution

### Technology Stack

- **Runtime**: Node.js v22.13.1
- **Language**: TypeScript 5.9.3 with ES Modules
- **Web Framework**: Fastify 5.6.1
- **WebSocket**: @fastify/websocket 11.2.0 (wraps `ws` library)
- **Job Queue**: BullMQ 5.63.0
- **Database**: PostgreSQL 13 (via pg 8.x)
- **Cache/Pub-Sub**: Redis 7 (via ioredis 5.8.2)
- **Development**: nodemon with ts-node/esm loader

## 🔧 Technical Deep Dive

### ES Modules + CommonJS Compatibility Challenge

#### The Problem

Node.js v22 with `"type": "module"` in `package.json` enforces ES module syntax throughout the project. However, several critical dependencies (`ioredis` for Redis, `pg` for PostgreSQL) are CommonJS modules that use `require()` syntax.

**Error encountered:**
```
ReferenceError: require is not defined in ES module scope
```

This happens because ES modules don't have access to the `require` function - they use `import` statements instead. But some libraries like `ioredis` haven't fully migrated to ES module exports.

#### The Solution: createRequire Workaround

We use Node.js's built-in `createRequire()` function to bridge the gap:

```typescript
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const IORedis = require("ioredis");
const { Pool } = require('pg');
```

**How it works:**
1. `createRequire(import.meta.url)` creates a `require` function scoped to the current module's URL
2. This synthetic `require` can load CommonJS modules just like in traditional Node.js
3. We maintain ES module benefits while accessing legacy CommonJS packages

**Where we use it:**
- `src/worker.ts` - For `ioredis` Redis client
- `src/db.ts` - For `pg` PostgreSQL client

**Alternative considered:** Dynamic imports (`await import('ioredis')`) don't work well with these specific packages due to default export issues.

### Fastify WebSocket Implementation Challenges

#### The Problem with @fastify/websocket

Fastify's WebSocket plugin (`@fastify/websocket`) wraps the underlying `ws` library but has some API quirks that caused confusion:

**Issues encountered:**

1. **Parameter Order Confusion:**
   ```typescript
   // ❌ WRONG - What we initially tried (standard route handler pattern)
   fastify.get('/api/order/status', { websocket: true }, (request, reply) => {
     // request.socket doesn't exist!
   })
   
   // ✅ CORRECT - WebSocket handler receives different parameters
   fastify.get('/api/order/status', { websocket: true }, (socket, request) => {
     // socket is the WebSocket connection object
   })
   ```
   
   Standard Fastify routes receive `(request, reply)`, but WebSocket routes receive `(socket, request)` - completely different parameter order!

2. **Type Definition Issues:**
   ```typescript
   // Error: Property 'socket' does not exist on type 'WebSocket'
   // Error: connection.send is not a function
   ```
   
   The TypeScript definitions weren't clear about what properties and methods were available.

3. **Query Parameter Access:**
   ```typescript
   // ❌ WRONG
   const orderId = socket.query.orderId;
   
   // ✅ CORRECT
   const orderId = (request.query as any)?.orderId;
   ```
   
   Query parameters live on the `request` object, not the socket.

#### Why We Use @fastify/websocket (Not Raw ws)

Even with these challenges, we chose `@fastify/websocket` because:

1. **Integration**: Seamlessly integrates with Fastify's lifecycle and error handling
2. **Route Registration**: Uses Fastify's routing system instead of separate WebSocket server
3. **Middleware Support**: Can use Fastify hooks and authentication middleware
4. **Single Port**: WebSocket and HTTP on same port (3000) without complex setup

**Under the hood:** `@fastify/websocket` uses the `ws` library (same as if we used raw WebSocket), it just provides a cleaner integration layer with Fastify.

### TypeScript + ts-node + nodemon Configuration

#### The Problem

Running TypeScript files directly with ES modules requires careful configuration:

**Initial error:**
```
TypeError: Unknown file extension '.ts' for /path/to/server.ts
```

Traditional `ts-node` with `--exec` flag doesn't work with ES modules in Node.js v22.

#### The Solution

**package.json scripts:**
```json
{
  "type": "module",
  "scripts": {
    "start": "nodemon --loader ts-node/esm --no-warnings=ExperimentalWarning src/server.ts",
    "worker": "nodemon --loader ts-node/esm --no-warnings=ExperimentalWarning src/worker.ts"
  }
}
```

**Key components:**
- `--loader ts-node/esm`: Uses ts-node's ESM loader (not the old `--exec` approach)
- `--no-warnings=ExperimentalWarning`: Suppresses experimental feature warnings
- `"type": "module"` in package.json: Enables ES modules globally

**tsconfig.json settings:**
```json
{
  "compilerServices": {
    "module": "ESNext",
    "moduleResolution": "node",
    "esModuleInterop": true
  },
  "ts-node": {
    "esm": true
  }
}
```

### Redis Pub/Sub Architecture

#### Why Pub/Sub Instead of Direct Communication

**The Challenge:** Worker process and server process are separate - they can't directly share memory or variables.

**Solution:** Redis pub/sub acts as a message broker:

```
Worker Process              Redis               Server Process
    |                         |                       |
    |---publish to channel--->|                       |
    |   "order-updates:123"   |                       |
    |                         |---forward message---->|
    |                         |                       |---send to WebSocket--->Client
```

**Channel naming pattern:** `order-updates:{orderId}`
- Each order gets its own Redis channel
- Server subscribes to specific order channels when clients connect
- Worker publishes updates to the order's specific channel

**Important caveat:** Redis pub/sub is **ephemeral** - messages aren't stored. If the server subscribes AFTER the worker publishes, the message is lost. That's why:
1. Worker waits 2 seconds before processing (gives time for WebSocket connection)
2. Database stores final states (for late-connecting clients)

### Database Persistence Strategy

#### Why PostgreSQL for Order History

**The Problem:** What if a client connects to the WebSocket AFTER the order completes?
- Redis pub/sub messages are gone
- No way to retrieve historical status

**Solution:** Dual-channel approach:

1. **Real-time path (Redis):** For active connections
   ```
   Order created → WebSocket connects → Redis pub/sub → Live updates → Client
   ```

2. **Historical path (PostgreSQL):** For late connections
   ```
   Order created → Worker saves to DB → Order completes → Client connects late → Query DB → Return final status
   ```

**Implementation in server.ts:**
```typescript
// Check database first
const existingOrder = await getOrderById(orderId);

if (existingOrder && (existingOrder.status === 'confirmed' || existingOrder.status === 'failed')) {
    // Order already completed - return final status and close
    socket.send(JSON.stringify({ status: existingOrder.status, data: {...} }));
    socket.close();
    return;
}

// Otherwise, subscribe to Redis for real-time updates
redisSubscriber.subscribe(`order-updates:${orderId}`);
```

#### Worker Database Updates

Every status change is persisted:

```typescript
// Must include tokenIn, tokenOut, amount on EVERY update
// These are NOT NULL columns in the database
await saveOrderStatus(orderId, {
    status: 'routing',
    tokenIn,    // Required!
    tokenOut,   // Required!
    amount      // Required!
});
```

**Why all three fields every time?**
The database uses an UPSERT pattern (`ON CONFLICT UPDATE`). If we only update status, PostgreSQL will try to set other required fields to NULL, violating constraints.

### BullMQ Job Queue

#### Why a Queue Instead of Direct Processing

**Alternative approach:** Process orders immediately in the POST endpoint

**Problems with immediate processing:**
- Long-running operations block the HTTP response
- No retry mechanism if DEX calls fail
- Can't scale to multiple worker processes
- No visibility into pending jobs

**BullMQ solution:**
1. POST endpoint adds job to queue (fast, returns immediately)
2. Worker processes pull jobs from queue
3. Built-in retry, delay, and concurrency management
4. Multiple workers can process jobs in parallel

**Configuration:**
```typescript
const orderWorker = new Worker('orderqueue', async job => {
  // Processing logic
}, {
  connection: { host: 'localhost', port: 6379 },
  concurrency: 10  // Process up to 10 orders simultaneously
});
```

### WebSocket Connection State Management

#### Active Connections Map

```typescript
const activeConnections = new Map<string, WebSocket>();
```

**Purpose:** Track which WebSocket clients are connected for each order ID

**Lifecycle:**
1. Client connects → `activeConnections.set(orderId, socket)`
2. Worker publishes to Redis → Server looks up socket in Map → Forwards message
3. Client disconnects → `activeConnections.delete(orderId)` (cleanup)

**Why a Map?** 
- O(1) lookup by orderId
- Automatic memory management with delete()
- Better than storing in Redis (avoids serialization overhead)

**Memory leak prevention:**
```typescript
socket.on('close', () => {
    activeConnections.delete(orderId);  // Critical cleanup!
    redisSubscriber.unsubscribe(`order-updates:${orderId}`);
});
```

Without this cleanup, disconnected sockets would stay in memory forever.

## 🗄️ Database Schema

### Orders Table

```sql
CREATE TABLE orders (
    order_id VARCHAR(255) PRIMARY KEY,
    token_in VARCHAR(50) NOT NULL,
    token_out VARCHAR(50) NOT NULL,
    amount NUMERIC NOT NULL,
    status VARCHAR(50) NOT NULL,
    dex VARCHAR(50),
    executed_price NUMERIC,
    tx_hash VARCHAR(255),
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## 📡 API Endpoints

### POST /api/order/execute

Create and execute a new swap order.

**Request Body:**
```json
{
  "tokenIn": "SOL",
  "tokenOut": "USDC",
  "amount": 10
}
```

**Response:**
```json
{
  "orderId": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Order submitted successfully."
}
```

### WebSocket /api/order/status?orderId={orderId}

Connect to receive real-time order status updates.

**Query Parameters:**
- `orderId` (required): The order ID from POST response

**Message Format:**
```json
{
  "orderId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "confirmed",
  "message": "Order successfully executed",
  "data": {
    "txHash": "mock_tx_123456",
    "executedPrice": 99.04,
    "dex": "Raydium"
  }
}
```

**Late Connection Behavior:**
If you connect to a WebSocket after the order is completed, the server will:
1. Query the database for the order
2. Return the final status immediately
3. Close the connection

This ensures clients can always retrieve order status, even if they connect after processing.

## 🐳 Docker Architecture

The application is fully containerized with 4 services orchestrated by Docker Compose:

### Services Overview

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| **postgres** | postgres:13 | 5432 | PostgreSQL database for order persistence |
| **redis** | redis:7 | 6379 | Redis for BullMQ job queue and pub/sub messaging |
| **server** | Custom (Node.js 22) | 3000 | Fastify API server with WebSocket support |
| **worker** | Custom (Node.js 22) | - | BullMQ worker for order processing |

### Docker Compose Configuration

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:13
    ports: 5432:5432
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: password
      POSTGRES_DB: order_execution
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U user -d order_execution"]
      interval: 10s
    networks:
      - order_engine_network

  redis:
    image: redis:7
    ports: 6379:6379
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
    networks:
      - order_engine_network

  server:
    build:
      context: .
      dockerfile: Dockerfile
    ports: 3000:3000
    environment:
      REDIS_HOST: redis
      POSTGRES_HOST: postgres
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    command: npm start
    networks:
      - order_engine_network

  worker:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      REDIS_HOST: redis
      POSTGRES_HOST: postgres
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    command: npm run worker
    networks:
      - order_engine_network

networks:
  order_engine_network:
    driver: bridge
```

### Key Docker Features

1. **Health Checks**: Ensures PostgreSQL and Redis are ready before starting server/worker
2. **Shared Network**: All containers communicate via `order_engine_network` bridge
3. **Service Discovery**: Containers reference each other by service name (e.g., `redis`, `postgres`)
4. **Volume Persistence**: Database and Redis data persisted across container restarts
5. **Single Dockerfile**: Both server and worker built from same image, different commands

### Environment Variables

The application uses environment variables for configuration, supporting both local and Docker deployments:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `REDIS_HOST` | localhost | Redis hostname (use `redis` in Docker) |
| `REDIS_PORT` | 6379 | Redis port |
| `POSTGRES_HOST` | localhost | PostgreSQL hostname (use `postgres` in Docker) |
| `POSTGRES_PORT` | 5432 | PostgreSQL port |
| `POSTGRES_DB` | order_execution | Database name |
| `POSTGRES_USER` | user | Database user |
| `POSTGRES_PASSWORD` | password | Database password |

**How fallbacks work:**
```typescript
// Code automatically detects environment
const host = process.env.POSTGRES_HOST || 'localhost';
// In Docker: uses 'postgres'
// Local dev: uses 'localhost'
```

## 🚦 Getting Started

### Prerequisites

- **For Docker deployment (Recommended):**
  - Docker and Docker Compose
  
- **For local development:**
  - Node.js v22.13.1 or higher
  - Docker and Docker Compose (for PostgreSQL and Redis)
  - npm or yarn package manager

### Installation

#### Option 1: Docker Deployment (Fully Containerized) ⭐

This is the recommended approach - runs everything in containers with zero local Node.js setup required.

1. **Clone the repository**
   ```bash
   cd order_engine
   ```

2. **Start all services with Docker Compose**
   ```bash
   docker-compose up -d
   ```

3. **Verify all containers are running**
   ```bash
   docker ps
   ```
   You should see 4 containers:
   - `order_engine-postgres-1` - PostgreSQL database
   - `order_engine-redis-1` - Redis cache/pub-sub
   - `order_engine-server-1` - Fastify API server
   - `order_engine-worker-1` - BullMQ worker process

4. **View logs (optional)**
   ```bash
   # All services
   docker-compose logs -f
   
   # Specific service
   docker-compose logs -f server
   docker-compose logs -f worker
   ```

5. **Stop all services**
   ```bash
   docker-compose down
   ```

6. **Stop and remove all data (clean slate)**
   ```bash
   docker-compose down -v
   ```

**How it works:**
- Server and worker share the same Docker image (built from `Dockerfile`)
- Different `command` overrides in `docker-compose.yml` determine which script runs
- All services communicate via internal `order_engine_network`
- PostgreSQL and Redis data persisted in Docker volumes
- Health checks ensure services start in correct order

#### Option 2: Local Development Mode

Run the application locally while using Docker only for PostgreSQL and Redis.

1. **Clone the repository**
   ```bash
   cd order_engine
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start Docker services (PostgreSQL & Redis only)**
   ```bash
   docker-compose up -d postgres redis
   ```

4. **Verify services are running**
   ```bash
   docker ps
   ```
   You should see `postgres` and `redis` containers running.

### Running the Application (Local Mode)

The application requires two processes running simultaneously:

#### Terminal 1: Start the Server
```bash
npm start
```

Expected output:
```
[SERVER] Redis subscriber connected successfully!
Database initialized successfully
Server listening at http://0.0.0.0:3000
```

#### Terminal 2: Start the Worker
```bash
npm run worker
```

Expected output:
```
Worker process started.
[WORKER] Connected to Redis successfully!
Worker is listening for jobs...
```

## 📝 Usage Examples

### Using Postman

1. **Create an Order**
   - Method: `POST`
   - URL: `http://localhost:3000/api/order/execute`
   - Headers: `Content-Type: application/json`
   - Body:
     ```json
     {
       "tokenIn": "SOL",
       "tokenOut": "USDC",
       "amount": 10
     }
     ```
   - Copy the `orderId` from the response

2. **Connect to WebSocket**
   - Create a new WebSocket Request
   - URL: `ws://localhost:3000/api/order/status?orderId={paste-order-id-here}`
   - Click Connect
   - Watch real-time status updates appear in the Messages panel

### Using cURL

**Create Order:**
```bash
curl -X POST http://localhost:3000/api/order/execute \
  -H "Content-Type: application/json" \
  -d '{"tokenIn":"SOL","tokenOut":"USDC","amount":10}'
```

**Connect WebSocket (using wscat):**
```bash
npm install -g wscat
wscat -c "ws://localhost:3000/api/order/status?orderId=YOUR_ORDER_ID"
```

## 🔧 Configuration

### Environment Variables

Create a `.env` file in the root directory (optional):

```env
PORT=3000
REDIS_HOST=localhost
REDIS_PORT=6379
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=order_execution
POSTGRES_USER=user
POSTGRES_PASSWORD=password
```

### TypeScript Configuration

The project uses ES modules with TypeScript:

**package.json:**
```json
{
  "type": "module",
  "scripts": {
    "start": "nodemon --loader ts-node/esm --no-warnings=ExperimentalWarning src/server.ts",
    "worker": "nodemon --loader ts-node/esm --no-warnings=ExperimentalWarning src/worker.ts"
  }
}
```

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "node",
    "esModuleInterop": true
  },
  "ts-node": {
    "esm": true
  }
}
```

## 🔍 Monitoring & Debugging

### Server Logs

The server logs include:
- WebSocket connection events
- Redis subscription confirmations
- Database initialization
- Order creation and status forwarding

Example:
```
[550e8400-e29b-41d4-a716-446655440000] WebSocket client connected.
[550e8400-e29b-41d4-a716-446655440000] Subscribed to order updates channel.
Forwarding message to client for order: 550e8400-e29b-41d4-a716-446655440000
```

### Worker Logs

The worker logs show detailed processing:
```
----------------------------------------------------
[550e8400-e29b-41d4-a716-446655440000] Processing order: Swap 10 SOL for USDC
[550e8400-e29b-41d4-a716-446655440000] Publishing: routing
(Raydium)   Quote received: 99.04501783613337
(Meteora)   Quote received: 97.70964216964444
[550e8400-e29b-41d4-a716-446655440000] Routing Decision: Raydium offered the best price
[550e8400-e29b-41d4-a716-446655440000] Publishing: building
[550e8400-e29b-41d4-a716-446655440000] Publishing: submitted
[550e8400-e29b-41d4-a716-446655440000] Publishing: confirmed
[550e8400-e29b-41d4-a716-446655440000] Job completed successfully!
----------------------------------------------------
```

### Database Logs

Check saved orders:
```bash
docker exec -it order_engine-postgres-1 psql -U user -d order_execution
```

```sql
SELECT order_id, token_in, token_out, amount, status, dex, executed_price, tx_hash 
FROM orders 
ORDER BY created_at DESC 
LIMIT 10;
```

## 🏗️ Project Structure

```
order_engine/
├── src/
│   ├── server.ts              # Main Fastify server with WebSocket
│   ├── worker.ts              # BullMQ worker for order processing
│   ├── db.ts                  # PostgreSQL connection and queries
│   └── services/
│       └── DEXrouter.ts       # Mock DEX integration
├── docker-compose.yml         # Docker services configuration
├── package.json               # Dependencies and scripts
├── tsconfig.json              # TypeScript configuration
└── README.md                  # This file
```

## 🔐 Security Considerations

⚠️ **Development Setup**: This configuration is for development only.

**For Production:**
- Use environment variables for all credentials
- Enable SSL/TLS for WebSocket connections (wss://)
- Implement authentication/authorization
- Use connection pooling limits
- Add rate limiting to API endpoints
- Validate and sanitize all inputs
- Use proper secret management (e.g., AWS Secrets Manager)

## 🐛 Troubleshooting

### Server won't start

**Issue**: `password authentication failed for user "postgres"`

**Root Cause:** The PostgreSQL credentials in `src/db.ts` don't match the Docker Compose configuration.

**Solution:** 
```typescript
// src/db.ts must match docker-compose.yml
export const pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'order_execution',  // Match POSTGRES_DB
    user: 'user',                 // Match POSTGRES_USER
    password: 'password',         // Match POSTGRES_PASSWORD
});
```

**Issue**: `EADDRINUSE: address already in use :::3000`

**Root Cause:** Another process is using port 3000.

**Solution:** 
```powershell
# Windows PowerShell
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# Or change the port
$env:PORT=3001; npm start
```

**Issue**: `TypeError: Unknown file extension '.ts'`

**Root Cause:** Incorrect nodemon/ts-node configuration for ES modules.

**Solution:** Ensure package.json uses `--loader` not `--exec`:
```json
{
  "scripts": {
    "start": "nodemon --loader ts-node/esm --no-warnings=ExperimentalWarning src/server.ts"
  }
}
```

### Worker not processing

**Issue**: Worker connects but doesn't process orders

**Root Cause:** Either server or worker not running, or Redis connection failed.

**Solution:** 
1. Verify both terminals are running:
   - Terminal 1: `npm start` (server)
   - Terminal 2: `npm run worker` (worker)
2. Check Redis: `docker ps | findstr redis`
3. Look for: `[WORKER] Connected to Redis successfully!` in logs

**Issue**: Jobs stuck in queue, never complete

**Root Cause:** Worker crashed during job processing.

**Solution:**
```bash
# Clear the queue and restart
docker exec -it order_engine-redis-1 redis-cli
> FLUSHDB
> exit
```

Then restart the worker.

### WebSocket not receiving updates

**Issue**: Connection established but no messages received

**Root Cause #1:** Worker completed processing before WebSocket subscribed to Redis.

**Why this happens:** Redis pub/sub is ephemeral - if you publish before anyone subscribes, the message is lost.

**Solution:** The 2-second delay in worker should prevent this:
```typescript
// worker.ts
await new Promise(res => setTimeout(res, 2000)); // Wait for WebSocket
```

**Root Cause #2:** Incorrect orderId in WebSocket URL.

**Solution:** Copy the exact orderId from POST response:
```
ws://localhost:3000/api/order/status?orderId=550e8400-e29b-41d4-a716-446655440000
```

**Issue**: `TypeError: connection.send is not a function`

**Root Cause:** Parameter order wrong in Fastify WebSocket handler.

**Wrong:**
```typescript
fastify.get('/path', { websocket: true }, (request, reply) => {
    request.send('message'); // ❌ request doesn't have send()
});
```

**Correct:**
```typescript
fastify.get('/path', { websocket: true }, (socket, request) => {
    socket.send('message'); // ✅ socket has send()
});
```

**Issue**: `Property 'query' does not exist on type 'WebSocket'`

**Root Cause:** Trying to access query params on socket instead of request.

**Solution:**
```typescript
// ❌ Wrong
const orderId = socket.query.orderId;

// ✅ Correct
const orderId = (request.query as any)?.orderId;
```

### Database errors

**Issue**: `null value in column "token_in" violates not-null constraint`

**Root Cause:** Worker calling `saveOrderStatus()` without including required fields.

**Why this happens:** The orders table has NOT NULL constraints on `token_in`, `token_out`, and `amount`. If you only update the status, PostgreSQL tries to set these to NULL, violating the constraint.

**Solution:** Include all required fields on EVERY update:
```typescript
// ❌ Wrong
await saveOrderStatus(orderId, { status: 'routing' });

// ✅ Correct
await saveOrderStatus(orderId, { 
    status: 'routing',
    tokenIn,   // Include original values
    tokenOut,
    amount
});
```

**Issue**: `Cannot read properties of null (reading 'status')`

**Root Cause:** Order doesn't exist in database yet, but WebSocket endpoint queries it.

**Solution:** The code already handles this - `getOrderById()` returns null if not found, and we check before accessing properties:
```typescript
const existingOrder = await getOrderById(orderId);
if (existingOrder) {  // ✅ Null check
    if (existingOrder.status === 'confirmed') {
        // ...
    }
}
```

**Issue**: Database connection timeout

**Root Cause:** PostgreSQL Docker container not running.

**Solution:**
```bash
docker ps                                    # Check if postgres running
docker-compose up -d postgres                # Start if not running
docker logs order_engine-postgres-1          # Check logs
```

### Redis connection issues

**Issue**: `ECONNREFUSED 127.0.0.1:6379`

**Root Cause:** Redis not running.

**Solution:**
```bash
docker-compose up -d redis
docker ps | findstr redis  # Verify running
```

**Issue**: `ReplyError: READONLY You can't write against a read only replica`

**Root Cause:** Connected to Redis replica instead of master.

**Solution:** This shouldn't happen in development with single Redis instance. Check docker-compose.yml isn't configured for replication.

### TypeScript compilation errors

**Issue**: `ReferenceError: require is not defined in ES module scope`

**Root Cause:** Trying to use `require()` directly in ES module.

**Solution:** Use createRequire workaround:
```typescript
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const IORedis = require("ioredis");
```

**Issue**: `Cannot find module 'ioredis' or its corresponding type declarations`

**Root Cause:** Package not installed.

**Solution:**
```bash
npm install ioredis
npm install --save-dev @types/node
```

### Docker-specific issues

**Issue**: Container exits immediately after starting

**Root Cause:** Application crashes due to missing dependencies or connection failures.

**Solution:**
```bash
# View logs to see error
docker-compose logs server
docker-compose logs worker

# Rebuild containers
docker-compose up -d --build
```

**Issue**: `Cannot connect to redis/postgres` from containers

**Root Cause:** Using `localhost` instead of service names in Docker network.

**Solution:** Environment variables automatically handle this - verify they're set correctly in docker-compose.yml:
```yaml
environment:
  REDIS_HOST: redis      # ✅ Service name, not localhost
  POSTGRES_HOST: postgres # ✅ Service name, not localhost
```

**Issue**: Port already in use (3000, 5432, or 6379)

**Root Cause:** Another service using the same port.

**Solution:**
```bash
# Option 1: Stop conflicting service
docker ps  # Find container ID
docker stop <container-id>

# Option 2: Change port in docker-compose.yml
ports:
  - "3001:3000"  # Map external 3001 to internal 3000
```

**Issue**: Changes to code not reflected in container

**Root Cause:** Docker image needs to be rebuilt.

**Solution:**
```bash
# Stop, rebuild, and restart
docker-compose down
docker-compose up -d --build

# Or rebuild specific service
docker-compose build server
docker-compose up -d server
```

**Issue**: Database tables not created automatically

**Root Cause:** Server started before database was ready (health check failed).

**Solution:**
```bash
# Check health status
docker-compose ps

# Restart server if postgres wasn't ready
docker-compose restart server
```

**Issue**: Worker not processing jobs in Docker

**Root Cause:** Worker container not running or can't connect to Redis.

**Solution:**
```bash
# Check worker status
docker-compose ps worker

# View worker logs
docker-compose logs -f worker

# Should see: "[WORKER] Connected to Redis successfully!"
```

## 📊 Performance Notes

- **Worker Concurrency**: Set to 10 concurrent jobs (configurable in worker.ts)
- **Connection Delay**: 2-second delay before processing allows WebSocket connection
- **Redis Pub/Sub**: Ephemeral - messages not stored, subscribers must connect first
- **Database Writes**: Every status change persisted for late-connection support
- **Global DEX Router**: Single MockDexRouter instance reused across all jobs (singleton pattern) - reduces memory allocation overhead since router methods are stateless

### Recent Optimizations

#### 1. Global DEX Router Instance (Implemented)

**Before:**
```typescript
const orderWorker = new Worker('orderqueue', async job => {
  const router = new MockDexRouter(); // ❌ New instance per job
  // ... processing
});
```

**After:**
```typescript
// Initialize once at module level
const router = new MockDexRouter(); // ✅ Reused across all jobs

const orderWorker = new Worker('orderqueue', async job => {
  // ... processing uses shared router
});
```

**Benefits:**
- **Memory Efficiency**: Avoids creating new MockDexRouter instance for each job (10 concurrent jobs = 10 instances previously)
- **Garbage Collection**: Reduces pressure on Node.js GC by eliminating frequent object allocation/deallocation
- **Startup Time**: Marginal improvement in job processing start time
- **Safe Implementation**: Works because MockDexRouter methods are stateless (no shared mutable state between calls)

**Performance Impact:**
- Memory savings: ~100-500 bytes per job (depends on router implementation)
- With 10 concurrent jobs: ~1-5 KB constant savings
- At high volume (1000 orders/min): Prevents ~16,000 object allocations per minute

## � Docker Command Reference

Quick reference for common Docker operations:

### Starting and Stopping

```bash
# Start all services
docker-compose up -d

# Start specific service
docker-compose up -d server

# Stop all services
docker-compose down

# Stop and remove volumes (clean slate)
docker-compose down -v
```

### Viewing Logs

```bash
# All services (follow mode)
docker-compose logs -f

# Specific service
docker-compose logs -f server
docker-compose logs -f worker

# Last 100 lines
docker-compose logs --tail=100 server
```

### Rebuilding

```bash
# Rebuild all services
docker-compose up -d --build

# Rebuild specific service
docker-compose build server
docker-compose up -d server

# Force rebuild without cache
docker-compose build --no-cache
```

### Container Management

```bash
# List running containers
docker-compose ps

# Restart service
docker-compose restart server

# Execute command in container
docker-compose exec server sh
docker-compose exec postgres psql -U user -d order_execution

# View resource usage
docker stats
```

### Debugging

```bash
# Check container health
docker-compose ps

# Inspect container
docker inspect order_engine-server-1

# View container logs (raw)
docker logs order_engine-server-1

# Access Redis CLI
docker-compose exec redis redis-cli
> PING
> KEYS *
> GET key_name

# Access PostgreSQL CLI
docker-compose exec postgres psql -U user -d order_execution
\dt                    # List tables
SELECT * FROM orders;  # Query orders
\q                     # Quit
```

### Cleanup

```bash
# Remove stopped containers
docker-compose rm

# Remove all unused images
docker image prune -a

# Remove all unused volumes
docker volume prune

# Complete cleanup (dangerous!)
docker system prune -a --volumes
```

## �🔄 Future Enhancements

- [ ] Real DEX integration (Raydium/Meteora SDKs)
- [ ] Authentication and user management
- [ ] Order history API endpoint
- [ ] WebSocket reconnection logic
- [ ] Prometheus metrics and Grafana dashboards
- [ ] Multiple token pair support
- [ ] Slippage tolerance configuration
- [ ] Transaction retry mechanism
- [ ] Email/SMS notifications on completion

## 📄 License

This project is for educational and development purposes.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

**Built with ❤️ using TypeScript, Fastify, and BullMQ**
