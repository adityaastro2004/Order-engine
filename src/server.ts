import Fastify from 'fastify';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const server = Fastify({ logger: true });

const orderQueue = new Queue('orderqueue', {
    connection: {
        host: 'localhost',
        port: 6379
    }
});


server.get('/', async (request, reply) => {
  return { status : 200, message: 'Server is running!' };
});

server.post('/api/order/execute', async (request, reply) => {
    try {
        const orderId = randomUUID();
        const rawBody = request.body;
        const orderdata = (typeof rawBody === 'object' && rawBody !== null) ? rawBody as Record<string, unknown> : {};
        server.log.info({ body: request.body }, "Received request body:"); 
        await orderQueue.add('market-queue', { orderId, ...orderdata });
        server.log.info(`[${orderId}] Order successfully added to the queue.`);
        return reply.status(201).send({ orderId });
    } catch (error) {
        server.log.error(error, "Failed to add order to the queue");
        return reply.status(500).send({ message: 'Internal Server Error' });
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