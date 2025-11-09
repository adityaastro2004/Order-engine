import Fastify from 'fastify';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import websocketPlugin from '@fastify/websocket';
import { WebSocket } from 'ws';
import dotenv from 'dotenv';
import { createRequire } from 'module';
dotenv.config();

const require = createRequire(import.meta.url);
const IORedis = require("ioredis");

const server = Fastify({ logger: true });
server.register(websocketPlugin);

const orderQueue = new Queue('orderqueue', {
    connection: {
        host: 'localhost',
        port: 6379
    }
});

// Create a Redis subscriber to listen for order updates from the worker
const redisSubscriber = new IORedis({ host: 'localhost', port: 6379 });

// Add connection event listeners
redisSubscriber.on('connect', () => {
    console.log('[SERVER] Redis subscriber connected successfully!');
});

redisSubscriber.on('ready', () => {
    console.log('[SERVER] Redis subscriber is ready!');
});

redisSubscriber.on('error', (err: any) => {
    console.error('[SERVER] Redis subscriber error:', err);
});

const activeConnections = new Map<string, WebSocket>();

server.get('/', async (request, reply) => {
  return { status : 200, message: 'Server is running!' };
});

server.post('/api/order/execute', async (request, reply) => {
    try {
        const orderId = randomUUID();
        const orderData = request.body as Record<string, unknown>;

        if (!orderData.tokenIn || !orderData.tokenOut || !orderData.amount) {
            return reply.status(400).send({ message: "Invalid order data. Required fields: tokenIn, tokenOut, amount" });
        }

        await orderQueue.add('market-queue', { orderId, ...orderData });
        
        server.log.info(`[${orderId}] Order successfully added to the queue via POST.`);

        // Immediately return the orderId. This fulfills the "Initial POST returns orderId" requirement.
        return reply.status(201).send({ orderId });

    } catch (error) {
        server.log.error(error, "Failed to add order to the queue");
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
});


server.register(async function (fastify) {
    fastify.get('/api/order/status', { websocket: true }, (socket, request) => {
        const orderId = (request.query as any)?.orderId;
        
        if (!orderId) {
            server.log.warn("Closing connection: Client connected without an orderId.");
            socket.send(JSON.stringify({ error: "orderId is required" }));
            socket.close();
            return;
        }

        server.log.info(`[${orderId}] WebSocket client connected.`);
        
        // Store the connection so the worker can send updates to it later.
        activeConnections.set(orderId, socket as WebSocket);
        
        // Subscribe to this specific order's updates channel
        redisSubscriber.subscribe(`order-updates:${orderId}`, (err: any) => {
            if (err) {
                server.log.error(`[${orderId}] Failed to subscribe to Redis channel: ${err}`);
            } else {
                server.log.info(`[${orderId}] Subscribed to order updates channel.`);
            }
        });
        
        // Send initial pending status
        socket.send(JSON.stringify({ 
            orderId, 
            status: "pending", 
            message: "Order received and queued for processing." 
        }));

        // When the client disconnects, remove them from our map to prevent memory leaks.
        socket.on('close', () => {
            activeConnections.delete(orderId);
            redisSubscriber.unsubscribe(`order-updates:${orderId}`);
            server.log.info(`[${orderId}] WebSocket client disconnected.`);
        });
    });
});

// Listen for messages from Redis and forward them to the appropriate WebSocket client
redisSubscriber.on('message', (channel: string, message: string) => {
    console.log(`[REDIS] Received message on channel: ${channel}`);
    console.log(`[REDIS] Message content: ${message}`);
    
    try {
        // Extract orderId from channel name (format: "order-updates:orderId")
        const parts = channel.split(':');
        const orderId = parts[1];
        
        if (!orderId) {
            server.log.warn(`Invalid channel format: ${channel}`);
            return;
        }
        
        server.log.info({ channel, message }, `Received message from Redis for order ${orderId}`);
        
        const update = JSON.parse(message);
        
        // Find the correct WebSocket connection for this orderId
        const socket = activeConnections.get(orderId);
        
        console.log(`[REDIS] Socket exists: ${!!socket}, Socket state: ${socket?.readyState}`);

        if (socket && socket.readyState === socket.OPEN) {
            // Send the update to the client
            const payload = JSON.stringify({ orderId, ...update });
            console.log(`[REDIS] Sending to client: ${payload}`);
            socket.send(payload);
            server.log.info(`[${orderId}] Sent status update to client: ${update.status}`);

            // If the order is finished, we can close the connection.
            if (update.status === 'confirmed' || update.status === 'failed') {
                setTimeout(() => {
                    socket.close();
                }, 1000); // Give client 1 second to receive the final message
            }
        } else {
            server.log.warn(`[${orderId}] No active WebSocket connection found for this order.`);
        }
    } catch (error) {
        server.log.error('Error processing message from Redis: ' + error);
    }
});


const start = async () => {
    try {
        await server.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });
    } catch (err) {
        server.log.error(err);
        process.exit(1);
    }
}

start();