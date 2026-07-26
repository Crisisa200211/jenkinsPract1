const express = require('express');
const { Pool } = require('pg');
const redis = require('redis');
const amqp = require('amqplib');
const app = express();
const port = process.env.PORT || 3001;

// PostgreSQL con pool de conexiones
const pool = new Pool({
    host: process.env.DB_HOST || 'postgres',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'userdb',
    user: process.env.DB_USER || 'user',
    password: process.env.DB_PASSWORD || 'password',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Redis para caché con retry
const redisClient = redis.createClient({
    url: `redis://${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || 6379}`,
    retry_strategy: (options) => {
        if (options.error && options.error.code === 'ECONNREFUSED') {
            return new Error('The server refused the connection');
        }
        if (options.total_retry_time > 1000 * 60 * 60) {
            return new Error('Retry time exhausted');
        }
        if (options.attempt > 10) {
            return undefined;
        }
        return Math.min(options.attempt * 100, 3000);
    }
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));
redisClient.connect();

// RabbitMQ para eventos
let channel;
const connectRabbitMQ = async () => {
    try {
        const connection = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://rabbitmq');
        channel = await connection.createChannel();
        await channel.assertQueue('user_events', { durable: true });
        console.log('✅ Connected to RabbitMQ');
    } catch (error) {
        console.error('❌ RabbitMQ connection failed:', error.message);
        setTimeout(connectRabbitMQ, 5000);
    }
};

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Endpoints CRUD con caché
app.post('/users', async (req, res) => {
    const { name, email } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO users (name, email, created_at) VALUES ($1, $2, NOW()) RETURNING *',
            [name, email]
        );
        
        // Emitir evento de usuario creado
        if (channel) {
            channel.sendToQueue('user_events', Buffer.from(JSON.stringify({
                event: 'user_created',
                data: result.rows[0],
                timestamp: new Date().toISOString()
            })));
        }
        
        res.status(201).json(result.rows[0]);
    } catch (error) {
        if (error.code === '23505') {
            res.status(409).json({ error: 'User already exists' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

app.get('/users/:id', async (req, res) => {
    const userId = req.params.id;
    
    // Intentar obtener de caché
    try {
        const cached = await redisClient.get(`user:${userId}`);
        if (cached) {
            return res.json({ source: 'cache', data: JSON.parse(cached) });
        }
    } catch (error) {
        console.error('Cache error:', error);
    }
    
    // Consultar base de datos
    try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Guardar en caché con TTL
        await redisClient.set(`user:${userId}`, JSON.stringify(result.rows[0]), {
            EX: 300
        });
        
        res.json({ source: 'database', data: result.rows[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check con detalles de servicios
app.get('/health', async (req, res) => {
    const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: {
            database: 'unknown',
            redis: 'unknown',
            rabbitmq: 'unknown'
        }
    };
    
    try {
        await pool.query('SELECT 1');
        health.services.database = 'connected';
    } catch (error) {
        health.services.database = 'disconnected';
        health.status = 'degraded';
    }
    
    try {
        await redisClient.ping();
        health.services.redis = 'connected';
    } catch (error) {
        health.services.redis = 'disconnected';
        health.status = 'degraded';
    }
    
    health.services.rabbitmq = channel ? 'connected' : 'disconnected';
    res.json(health);
});

// Iniciar servicios
connectRabbitMQ();
app.listen(port, () => {
    console.log(`👤 User Service running on port ${port}`);
});

module.exports = { app, pool, redisClient, channel };