import Fastify from 'fastify';
import dotenv from 'dotenv';
dotenv.config();

const server = Fastify({ logger: true });

server.get('/', async (request, reply) => {
  return { status : 200, message: 'Server is running!' };
});

const start = async () => {
    try {
        await server.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });
        console.log(`Server is running on http://localhost:${process.env.PORT || 3000}`);
    } catch (err) {
        server.log.error(err);
        process.exit(1);
    }
}

start();