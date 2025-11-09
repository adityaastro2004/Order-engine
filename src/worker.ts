import { Worker } from "bullmq";

console.log("Worker starting...");

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const orderWorker = new Worker('orderqueue', async job => {
  const { orderId, tokenIn, tokenOut, amount } = job.data;
  
  console.log(`[${orderId}] Processing order: Swap ${amount} ${tokenIn} for ${tokenOut}`);
  
  // Simulate doing some work (e.g., calling a DEX)
  await sleep(3000); // Wait for 3 seconds
  
  // DEX routing will come here.
  
  console.log(`[${orderId}] Finished processing.`);
  return { status: 'Completed', timestamp: new Date() };
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