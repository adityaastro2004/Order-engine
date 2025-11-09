

const generateMockTxHash = () => `mock_tx_${Buffer.from(Math.random().toString()).toString('hex').substring(0, 10)}`;

// This is our new class for handling all DEX-related logic.
export class MockDexRouter {
    // A private helper to simulate network delays.
    private async sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Simulates getting a quote from Raydium.
    async getRaydiumQuote(tokenIn: string, tokenOut: string, amount: number) {
        console.log(`(Raydium)   Getting quote for ${amount} ${tokenIn} -> ${tokenOut}...`);
        await this.sleep(250); 
        // Simulate realistic network latency, and the logic - return a base price with a small random variation betweeen 98% and 102%.
        const price = 100 * (0.98 + Math.random() * 0.04);
        console.log(`(Raydium)   Quote received: ${price}`);
        return { dex: 'Raydium', price: price };
    }

    // Simulates getting a quote from Meteora.
    async getMeteoraQuote(tokenIn: string, tokenOut: string, amount: number) {
        console.log(`(Meteora)   Getting quote for ${amount} ${tokenIn} -> ${tokenOut}...`);
        await this.sleep(300); 
        // Make it slightly different from Raydium's delay and a slightly different price range, from 97% to 102%, keeping the logic similar.
        const price = 100 * (0.97 + Math.random() * 0.05);
        console.log(`(Meteora)   Quote received: ${price}`);
        return { dex: 'Meteora', price: price };
    }

    // Simulates executing the final swap on the chosen DEX.
    async executeSwap(dex: string, tokenIn: string, tokenOut: string, amount: number, finalPrice: number) {
        console.log(`(Execution) Executing swap on ${dex} for ${amount} ${tokenIn}...`);
        // Simulate the longer execution time (2-3 seconds) as mentioned in the assignment.
        await this.sleep(2000 + Math.random() * 1000); 
        const txHash = generateMockTxHash();
        console.log(`(Execution) Swap successful! TxHash: ${txHash}`);
        return {
            txHash: txHash,
            executedPrice: finalPrice,
        };
    }
}