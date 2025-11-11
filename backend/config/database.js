const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const createDbConnection = () => {
  return mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'network_monitor',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '+00:00'
  });
};

const initializeDatabase = async (db) => {
  try {
    // Main measurements table
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

    // PERFORMANCE OPTIMIZATION: Add composite index for better query performance on time-range queries
    // This index is critical for getRangeMeasurementsSmart queries
    // Uncomment and run manually if queries are slow:
    // await db.execute(`CREATE INDEX IF NOT EXISTS idx_proxy_port_created_target ON measurements (proxy_port, created_at, target_host)`);

    // InnoDB table for IP information - Use DECIMAL for large numbers
    await db.execute(`
        CREATE TABLE IF NOT EXISTS ip_ranges (
          start_ip_numeric DECIMAL(39, 0) UNSIGNED NOT NULL,
          end_ip_numeric DECIMAL(39, 0) UNSIGNED NOT NULL,
          start_ip VARCHAR(45) NOT NULL,
          end_ip VARCHAR(45) NOT NULL,
          asn VARCHAR(20) NOT NULL,
          company VARCHAR(255) NOT NULL,
          domain VARCHAR(255),
          ip_type ENUM('ipv4', 'ipv6') NOT NULL,
          PRIMARY KEY (start_ip_numeric, end_ip_numeric),
          INDEX idx_range (start_ip_numeric, end_ip_numeric),
          INDEX idx_asn (asn),
          INDEX idx_company (company(100)),
          INDEX idx_ip_type (ip_type)
        ) ENGINE=InnoDB
      `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS ip_company_cache (
          ip VARCHAR(45) PRIMARY KEY,
          company VARCHAR(255) NOT NULL,
          country VARCHAR(100),
          asn VARCHAR(20),
          ip_numeric DECIMAL(39, 0) UNSIGNED,  -- For binary search compatibility
          last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          source ENUM('ip_ranges', 'manual') DEFAULT 'ip_ranges',
          INDEX idx_company (company),
          INDEX idx_ip_numeric (ip_numeric)  -- Important for fast lookups
      ) ENGINE=MEMORY
      `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS error_logs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          server_ip VARCHAR(45) NOT NULL,
          log_level ENUM('error', 'warn', 'alert', 'info', 'debug') NOT NULL,
          original_timestamp DATETIME NOT NULL,
          nginx_pid INT,
          client_ip VARCHAR(45),
          upstream TEXT,
          server_name VARCHAR(255),
          request TEXT,
          host VARCHAR(255),
          error_message TEXT NOT NULL,
          full_log_text TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_server_ip (server_ip),
          INDEX idx_log_level (log_level),
          INDEX idx_timestamp (original_timestamp),
          INDEX idx_created_at (created_at),
          INDEX idx_client_ip (client_ip)
        ) ENGINE=InnoDB
      `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS bandwidth_measurements (
          id INT AUTO_INCREMENT PRIMARY KEY,
          ip_address VARCHAR(45) NOT NULL,
          proxy_port INT NOT NULL DEFAULT 0,
          up_bandwidth DECIMAL(10,2) NOT NULL,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_ip_timestamp (ip_address, timestamp),
          INDEX idx_proxy_port (proxy_port),
          INDEX idx_proxy_port_timestamp (proxy_port, timestamp)
        )
      `);

    const addColumnIfMissing = async (query, context, duplicateCodes = [1060]) => {
      try {
        await db.execute(query);
      } catch (error) {
        if (!duplicateCodes.includes(error.errno)) {
          console.error(`❌ Failed to execute schema change for ${context}:`, error.message);
          throw error;
        }
        console.log(`ℹ️  Schema change skipped for ${context}: already applied`);
      }
    };

    await addColumnIfMissing(
      'ALTER TABLE bandwidth_measurements ADD COLUMN proxy_port INT NOT NULL DEFAULT 0 AFTER ip_address',
      'bandwidth_measurements.proxy_port'
    );

    await addColumnIfMissing(
      'ALTER TABLE bandwidth_measurements ADD INDEX idx_proxy_port (proxy_port)',
      'bandwidth_measurements.idx_proxy_port',
      [1061]
    );

    await addColumnIfMissing(
      'ALTER TABLE bandwidth_measurements ADD INDEX idx_proxy_port_timestamp (proxy_port, timestamp)',
      'bandwidth_measurements.idx_proxy_port_timestamp',
      [1061]
    );

    await db.execute(`
        CREATE TABLE IF NOT EXISTS ttl_quality_snapshots (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          proxy_port INT NOT NULL,
          target_host VARCHAR(255) NOT NULL,
          target_port INT NOT NULL,
          window_start DATETIME NOT NULL,
          window_end DATETIME NOT NULL,
          sample_count INT NOT NULL,
          success_count INT NOT NULL,
          timeout_count INT NOT NULL,
          error_count INT NOT NULL,
          avg_rtt_ms DECIMAL(10,2),
          max_rtt_ms DECIMAL(10,2),
          quality ENUM('good','warning','bad') NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_ttl_window (proxy_port, target_host, target_port, window_start),
          KEY idx_ttl_quality_port_window (proxy_port, window_start),
          KEY idx_ttl_quality_quality (quality)
        ) ENGINE=InnoDB
      `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS bandwidth_quality_snapshots (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          proxy_port INT NOT NULL,
          ip_address VARCHAR(45) NOT NULL,
          window_start DATETIME NOT NULL,
          window_end DATETIME NOT NULL,
          sample_count INT NOT NULL,
          avg_bandwidth_mbps DECIMAL(10,2),
          max_bandwidth_mbps DECIMAL(10,2),
          quality ENUM('good','warning','bad') NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_bandwidth_window (proxy_port, ip_address, window_start),
          KEY idx_bandwidth_quality_port_window (proxy_port, window_start),
          KEY idx_bandwidth_quality_quality (quality)
        ) ENGINE=InnoDB
      `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS server_metrics (
          id INT AUTO_INCREMENT PRIMARY KEY,
          server VARCHAR(255) NOT NULL,
          timestamp DATETIME NOT NULL,
          cpu_usage DECIMAL(5,2) DEFAULT 0,
          mem_usage DECIMAL(5,2) DEFAULT 0,
          disk_read_mb DECIMAL(12,2) DEFAULT 0,
          disk_write_mb DECIMAL(12,2) DEFAULT 0,
          disk_read_mb_per_min DECIMAL(12,2) DEFAULT 0,
          disk_write_mb_per_min DECIMAL(12,2) DEFAULT 0,
          nginx_request_count_per_min INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_server (server),
          INDEX idx_timestamp (timestamp),
          INDEX idx_server_timestamp (server, timestamp),
          INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB
      `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS cdn_servers (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          ip_address VARCHAR(45) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_cdn_server_ip (ip_address),
          UNIQUE KEY uniq_cdn_server_name (name)
        ) ENGINE=InnoDB
      `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS cdn_server_domains (
          id INT AUTO_INCREMENT PRIMARY KEY,
          server_id INT NOT NULL,
          domain VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT fk_cdn_server_domains_server
            FOREIGN KEY (server_id) REFERENCES cdn_servers(id)
            ON DELETE CASCADE,
          UNIQUE KEY uniq_server_domain (server_id, domain),
          INDEX idx_cdn_domain_server (server_id)
        ) ENGINE=InnoDB
      `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS accounts (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          account_key VARCHAR(64) UNIQUE,
          type ENUM('personal','bot') DEFAULT 'personal',
          notes TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB
      `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS system_settings (
          setting_key VARCHAR(100) PRIMARY KEY,
          setting_value TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB
      `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS contacts (
          id INT AUTO_INCREMENT PRIMARY KEY,
          account_id INT NULL,
          name VARCHAR(255) NOT NULL,
          telegram_username VARCHAR(255),
          telegram_chat_id BIGINT,
          first_name VARCHAR(255),
          last_name VARCHAR(255),
          telegram_phone VARCHAR(50),
          role VARCHAR(100),
          is_important TINYINT(1) DEFAULT 0,
          notify_on_external TINYINT(1) DEFAULT 1,
          notes TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_contacts_username (telegram_username),
          INDEX idx_contacts_account (account_id),
          INDEX idx_contacts_role (role),
          INDEX idx_contacts_important (is_important),
          INDEX idx_contacts_username (telegram_username),
          INDEX idx_contacts_chat (telegram_chat_id),
          CONSTRAINT fk_contacts_account
            FOREIGN KEY (account_id) REFERENCES accounts(id)
            ON DELETE SET NULL
        ) ENGINE=InnoDB
      `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          account_id INT NOT NULL,
          contact_id INT NULL,
          chat_id BIGINT NULL,
          chat_title VARCHAR(255),
          sender_username VARCHAR(255),
          sender_display VARCHAR(255),
          direction ENUM('incoming','outgoing') NOT NULL,
          message TEXT,
          has_media TINYINT(1) DEFAULT 0,
          payload JSON NULL,
          occurred_at DATETIME NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_chat_messages_account (account_id, occurred_at),
          INDEX idx_chat_messages_contact (contact_id, occurred_at),
          INDEX idx_chat_messages_chat (chat_id, occurred_at),
          FULLTEXT INDEX ft_chat_messages_text (message),
          CONSTRAINT fk_chat_messages_account
            FOREIGN KEY (account_id) REFERENCES accounts(id)
            ON DELETE CASCADE,
          CONSTRAINT fk_chat_messages_contact
            FOREIGN KEY (contact_id) REFERENCES contacts(id)
            ON DELETE SET NULL
        ) ENGINE=InnoDB
        /*!50100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci */
      `);

    await addColumnIfMissing(
      'ALTER TABLE contacts ADD COLUMN account_id INT NULL AFTER id',
      'contacts.account_id'
    );

    await addColumnIfMissing(
      'ALTER TABLE contacts ADD COLUMN first_name VARCHAR(255) NULL AFTER telegram_chat_id',
      'contacts.first_name'
    );

    await addColumnIfMissing(
      'ALTER TABLE contacts ADD COLUMN last_name VARCHAR(255) NULL AFTER first_name',
      'contacts.last_name'
    );

    await addColumnIfMissing(
      'ALTER TABLE contacts ADD COLUMN telegram_phone VARCHAR(50) NULL AFTER last_name',
      'contacts.telegram_phone'
    );

    try {
      await db.execute('ALTER TABLE contacts DROP INDEX uniq_contacts_username');
    } catch (error) {
      if (error.code !== 'ER_CANT_DROP_FIELD_OR_KEY' && error.code !== 'ER_DROP_INDEX_FK' && error.code !== 'ER_KEY_DOES_NOT_EXIST') {
        console.error('❌ Failed to drop uniq_contacts_username:', error.message);
        throw error;
      }
    }

    try {
      await db.execute('ALTER TABLE contacts ADD UNIQUE KEY uniq_contacts_account_username (account_id, telegram_username)');
    } catch (error) {
      if (error.code !== 'ER_DUP_KEYNAME' && error.code !== 'ER_ALTER_OPERATION_NOT_SUPPORTED_REASON' && !error.message.includes('Duplicate key name')) {
        console.error('❌ Failed to add uniq_contacts_account_username:', error.message);
        throw error;
      }
    }

    try {
      await db.execute('ALTER TABLE contacts ADD UNIQUE KEY uniq_contacts_account_chat (account_id, telegram_chat_id)');
    } catch (error) {
      if (error.code !== 'ER_DUP_KEYNAME' && error.code !== 'ER_ALTER_OPERATION_NOT_SUPPORTED_REASON' && !error.message.includes('Duplicate key name')) {
        console.error('❌ Failed to add uniq_contacts_account_chat:', error.message);
        throw error;
      }
    }

    try {
      await db.execute(`
        ALTER TABLE contacts
        ADD CONSTRAINT fk_contacts_account
        FOREIGN KEY (account_id) REFERENCES accounts(id)
        ON DELETE SET NULL
      `);
    } catch (error) {
      const duplicateForeignKey =
        typeof error.message === 'string' && error.message.includes('Duplicate foreign key');
      if (
        error.code !== 'ER_DUP_KEYNAME' &&
        error.code !== 'ER_CANT_CREATE_TABLE' &&
        error.code !== 'ER_DUP_FOREIGN_KEY' &&
        !duplicateForeignKey
      ) {
        console.error('❌ Failed to add contacts.account_id foreign key:', error.message);
        throw error;
      }
    }

    try {
      await db.execute('ALTER TABLE contacts ADD INDEX idx_contacts_account (account_id)');
    } catch (error) {
      if (error.code !== 'ER_DUP_KEYNAME') {
        throw error;
      }
    }

    await db.execute("SET time_zone = '+00:00';");
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