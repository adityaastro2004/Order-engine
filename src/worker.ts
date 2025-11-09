import { Worker } from "bullmq";
import { MockDexRouter } from "./services/DEXrouter.js";

console.log("Worker starting...");

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const orderWorker = new Worker('orderqueue', async job => {
  const { orderId, tokenIn, tokenOut, amount } = job.data;
  
  console.log(`[${orderId}] Processing order: Swap ${amount} ${tokenIn} for ${tokenOut}`);
  
  const router = new MockDexRouter();

  // We use Promise.all to fetch both quotes concurrently to save time.
  console.log(`[${orderId}] STAGE: ROUTING - Fetching quotes...`);
  const [raydiumQuote, meteoraQuote] = await Promise.all([
      router.getRaydiumQuote(tokenIn, tokenOut, amount),
      router.getMeteoraQuote(tokenIn, tokenOut, amount)
  ]);

  const bestQuote = raydiumQuote.price > meteoraQuote.price ? raydiumQuote : meteoraQuote;
  
  // This is a required deliverable: Log the routing decision for transparency.
  console.log(`[${orderId}] STAGE: ROUTING - Decision: ${bestQuote.dex} offered the best price (${bestQuote.price}).`);

  console.log(`[${orderId}] STAGE: BUILDING & SUBMITTING - Executing swap...`);
  const result = await router.executeSwap(bestQuote.dex, tokenIn, tokenOut, amount, bestQuote.price);
  
  console.log(`[${orderId}] STAGE: CONFIRMED - Transaction successful.`);
  return { status: 'Completed', ...result };
  
}, {
  connection: {
    host: 'localhost',
    port: 6379
  },
  concurrency: 10 
});

// Event listeners for logging
orderWorker.on('completed', (job, result) => {
  console.log(`[${job.data.orderId}] Job completed! Result:`, result);
});

orderWorker.on('failed', (job, err) => {
  const orderId = job ? job.data.orderId : 'unknown';
  console.error(`[${orderId}] Job failed:`, err);
});

console.log("Worker is listening for jobs...");