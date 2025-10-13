const mysql = require('mysql2/promise');
require('dotenv').config();

const createDbConnection = () => {
  return mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'network_monitor',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
};

const initializeDatabase = async (db) => {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS measurements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        target_host VARCHAR(255) NOT NULL,
        target_port INT NOT NULL,
        proxy_host VARCHAR(255) NOT NULL,
        proxy_port INT NOT NULL,
        status VARCHAR(50) NOT NULL,
        rtt_ms DECIMAL(10,2),
        error_message TEXT,
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_target (target_host, target_port),
        INDEX idx_proxy (proxy_host, proxy_port),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at)
      )
    `);
    
    console.log('✅ Database tables initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
    throw error;
  }
};

module.exports = {
  createDbConnection,
  initializeDatabase
};