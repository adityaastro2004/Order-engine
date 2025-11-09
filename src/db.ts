import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');

// Create a PostgreSQL connection pool
// Uses environment variables for Docker compatibility, falls back to localhost for local development
export const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB || 'order_execution',
    user: process.env.POSTGRES_USER || 'user',
    password: process.env.POSTGRES_PASSWORD || 'password',
});

// Initialize the database table
export async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
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
            )
        `);
        console.log('[DB] Orders table initialized successfully');
    } catch (error) {
        console.error('[DB] Error initializing database:', error);
    } finally {
        client.release();
    }
}

// Save or update order status
export async function saveOrderStatus(orderId: string, data: any) {
    const client = await pool.connect();
    try {
        const { tokenIn, tokenOut, amount, status, dex, executedPrice, txHash, errorMessage } = data;
        
        await client.query(`
            INSERT INTO orders (order_id, token_in, token_out, amount, status, dex, executed_price, tx_hash, error_message, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
            ON CONFLICT (order_id) 
            DO UPDATE SET 
                status = EXCLUDED.status,
                dex = EXCLUDED.dex,
                executed_price = EXCLUDED.executed_price,
                tx_hash = EXCLUDED.tx_hash,
                error_message = EXCLUDED.error_message,
                updated_at = CURRENT_TIMESTAMP
        `, [orderId, tokenIn, tokenOut, amount, status, dex, executedPrice, txHash, errorMessage]);
        
        console.log(`[DB] Order ${orderId} saved with status: ${status}`);
    } catch (error) {
        console.error('[DB] Error saving order:', error);
    } finally {
        client.release();
    }
}

// Get order by ID
export async function getOrderById(orderId: string) {
    const client = await pool.connect();
    try {
        const result = await client.query(
            'SELECT * FROM orders WHERE order_id = $1',
            [orderId]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('[DB] Error fetching order:', error);
        return null;
    } finally {
        client.release();
    }
}
