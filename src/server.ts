import Fastify from 'fastify';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import websocketPlugin from '@fastify/websocket';
import { WebSocket } from 'ws';
import dotenv from 'dotenv';
dotenv.config();

const server = Fastify({ logger: true });
server.register(websocketPlugin);

const orderQueue = new Queue('orderqueue', {
    connection: {
        host: 'localhost',
        port: 6379
    }
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
        
        socket.send(JSON.stringify({ orderId, status: "subscribed", message: "You are now subscribed to order status updates." }));

        // When the client disconnects, remove them from our map to prevent memory leaks.
        socket.on('close', () => {
            activeConnections.delete(orderId);
            server.log.info(`[${orderId}] WebSocket client disconnected.`);
        });
    });
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