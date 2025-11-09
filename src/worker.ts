import { Worker } from "bullmq";
import { MockDexRouter } from "./services/DEXrouter.js";
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const IORedis = require("ioredis");

// Create a Redis client dedicated to publishing status updates.
const publisher = new IORedis({
    host: 'localhost',
    port: 6379,
    maxRetriesPerRequest: null
});

// Add connection event listeners
publisher.on('connect', () => {
    console.log('[WORKER] Connected to Redis successfully!');
});

publisher.on('error', (err: any) => {
    console.error('[WORKER] Redis connection error:', err);
});

console.log("Worker process started.");

const orderWorker = new Worker('orderqueue', async job => {
  const { orderId, tokenIn, tokenOut, amount } = job.data;
  // The channel name is specific to each order, so updates go to the right client.
  const channel = `order-updates:${orderId}`;

  console.log(`----------------------------------------------------`);
  console.log(`[${orderId}] Processing order: Swap ${amount} ${tokenIn} for ${tokenOut}`);
  
  // Give the WebSocket client a moment to connect and subscribe
  console.log(`[${orderId}] Waiting for WebSocket client to connect...`);
  await new Promise(res => setTimeout(res, 10000)); // Wait 10 seconds
  
  const router = new MockDexRouter();

  // STAGE 1: ROUTING
  // Announce that we are starting the routing process.
  console.log(`[${orderId}] Publishing: routing`);
  await publisher.publish(channel, JSON.stringify({ 
      status: 'routing', 
      message: 'Comparing DEX prices...' 
  }));
  const [raydiumQuote, meteoraQuote] = await Promise.all([
      router.getRaydiumQuote(tokenIn, tokenOut, amount),
      router.getMeteoraQuote(tokenIn, tokenOut, amount)
  ]);
  const bestQuote = raydiumQuote.price > meteoraQuote.price ? raydiumQuote : meteoraQuote;
  console.log(`[${orderId}] Routing Decision: ${bestQuote.dex} offered the best price (${bestQuote.price}).`);

  // STAGE 2: BUILDING
  // Announce that we are building the transaction.
  console.log(`[${orderId}] Publishing: building`);
  await publisher.publish(channel, JSON.stringify({ 
      status: 'building', 
      message: `Creating transaction for ${bestQuote.dex}...` 
  }));
  
  // STAGE 3: SUBMITTED
  // We add a small artificial delay to make the UI feel more natural.
  await new Promise(res => setTimeout(res, 500)); 
  console.log(`[${orderId}] Publishing: submitted`);
  await publisher.publish(channel, JSON.stringify({ 
      status: 'submitted', 
      message: 'Transaction sent to network, awaiting confirmation.' 
  }));
  
  // This call simulates the network confirmation time.
  const result = await router.executeSwap(bestQuote.dex, tokenIn, tokenOut, amount, bestQuote.price);
  
  // STAGE 4: CONFIRMED
  // Announce that the transaction was successful and include the final data.
  console.log(`[${orderId}] Publishing: confirmed`);
  await publisher.publish(channel, JSON.stringify({ 
      status: 'confirmed', 
      data: result 
  }));

  console.log(`[${orderId}] Processing finished.`);
  return { status: 'Completed', ...result };

}, {
  connection: {
    host: 'localhost',
    port: 6379
  },
  concurrency: 10 
});

// EVENT LISTENERS

orderWorker.on('completed', (job, result) => {
  console.log(`[${job.data.orderId}] Job completed successfully!`);
  console.log(`----------------------------------------------------`);
});

// STAGE 5: FAILED
// This listener catches any error from the main job function.
orderWorker.on('failed', async (job, err) => {
  const orderId = job ? job.data.orderId : 'unknown';
  const channel = `order-updates:${orderId}`;
  console.error(`[${orderId}] Job failed with error: ${err.message}`);
  
  // Announce that the job has failed and include the error message.
  console.log(`[${orderId}] Publishing: failed`);
  await publisher.publish(channel, JSON.stringify({
      status: 'failed',
      error: err.message
  }));
  console.log(`----------------------------------------------------`);
});

console.log("Worker is listening for jobs...");